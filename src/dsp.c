/*
 * janey DSP core
 *
 * A small unit-generator graph rendered sample by sample in C. Janet (the
 * language) is only used to *build* the graph: every call such as
 * (sine 220) appends a node to the graph under construction and returns an
 * opaque signal handle. Arithmetic on handles (+ - * /) also builds nodes, so
 * patches read like ordinary Janet. Audio rendering never re-enters the VM.
 *
 * Live coding: each successful (play ...) evaluation swaps in the new graph
 * and crossfades from the old one. Sequencers read a global beat clock, so
 * timing survives reloads.
 */
#include <janet.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT(name) __attribute__((export_name(name)))

#define MAXN 512
#define MAXSTEPS 64
#define MAXBLOCK 1024
#define MAXDELAY_SEC 4.0
#define FADE_SEC 0.04
#define TWO_PI 6.283185307179586

enum {
    N_SINE, N_SAW, N_SQUARE, N_TRI, N_NOISE,
    N_LP, N_HP, N_BP,
    N_ADD, N_SUB, N_MUL, N_DIV,
    N_DRIVE, N_MTOF,
    N_SEQ, N_TRIG, N_AD, N_DELAY
};

typedef struct { float c; int16_t n; } In; /* n < 0: constant c, else node index */

typedef struct {
    uint8_t type;
    In in[3];
    double ph;            /* osc phase / env level */
    double s1, s2;        /* filter state / env stage+prev */
    int64_t last;         /* last sequencer step */
    int inited;
    float hold;           /* seq held value */
    int nsteps;
    float steps[MAXSTEPS];
    uint8_t on[MAXSTEPS];
    float *buf;           /* delay line */
    int blen, bpos;
    uint32_t rng;
} Node;

typedef struct {
    Node nodes[MAXN];
    float val[MAXN];
    int n;
    int outl, outr;
    int gen;
} Graph;

typedef struct { int gen; int idx; } Sig;

static double g_sr = 48000.0;
static double g_bpm = 120.0;
static double g_beat = 0.0;
static int g_gen = 0;

static Graph *g_cur = NULL;   /* playing */
static Graph *g_prev = NULL;  /* fading out */
static Graph *g_bld = NULL;   /* being built by the running eval */
static int g_played = 0;
static int g_fade_left = 0, g_fade_len = 1;

static float g_outl[MAXBLOCK], g_outr[MAXBLOCK];

static JanetTable *g_env;
static char g_result[4096];
static int g_result_len;

/* ------------------------------------------------------------------ graph */

static Graph *graph_new(void) {
    Graph *g = calloc(1, sizeof(Graph));
    if (!g) return NULL;
    g->gen = ++g_gen;
    g->outl = g->outr = -1;
    return g;
}

static void graph_free(Graph *g) {
    if (!g) return;
    for (int i = 0; i < g->n; i++) free(g->nodes[i].buf);
    free(g);
}

static inline float rd(const Graph *g, const In *in) {
    return in->n < 0 ? in->c : g->val[in->n];
}

static inline double blep(double t, double dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1.0; }
    if (t > 1.0 - dt) { t = (t - 1.0) / dt; return t * t + t + t + 1.0; }
    return 0.0;
}

static void graph_tick(Graph *g, float *outl, float *outr) {
    const double sr = g_sr;
    for (int i = 0; i < g->n; i++) {
        Node *n = &g->nodes[i];
        float v = 0.f;
        switch (n->type) {
        case N_SINE: case N_SAW: case N_SQUARE: case N_TRI: {
            double dt = rd(g, &n->in[0]) / sr;
            if (dt < 0) dt = -dt;
            if (dt > 0.5) dt = 0.5;
            double t = n->ph;
            if (n->type == N_SINE) v = (float)sin(TWO_PI * t);
            else if (n->type == N_SAW) v = (float)(2.0 * t - 1.0 - blep(t, dt));
            else if (n->type == N_SQUARE) {
                double t2 = t + 0.5; if (t2 >= 1.0) t2 -= 1.0;
                v = (float)((t < 0.5 ? 1.0 : -1.0) + blep(t, dt) - blep(t2, dt));
            } else v = (float)(4.0 * fabs(t - 0.5) - 1.0);
            t += dt; if (t >= 1.0) t -= 1.0;
            n->ph = t;
            break;
        }
        case N_NOISE: {
            uint32_t x = n->rng ? n->rng : 0x9e3779b9u;
            x ^= x << 13; x ^= x >> 17; x ^= x << 5;
            n->rng = x;
            v = (float)((double)x / 2147483648.0 - 1.0);
            break;
        }
        case N_LP: case N_HP: case N_BP: {
            /* TPT state-variable filter */
            double x = rd(g, &n->in[0]);
            double fc = rd(g, &n->in[1]);
            double q = rd(g, &n->in[2]);
            if (fc < 10) fc = 10;
            if (fc > 0.45 * sr) fc = 0.45 * sr;
            if (q < 0.5) q = 0.5;
            double gg = tan(3.141592653589793 * fc / sr);
            double k = 1.0 / q;
            double a1 = 1.0 / (1.0 + gg * (gg + k)), a2 = gg * a1, a3 = gg * a2;
            double v3 = x - n->s2;
            double v1 = a1 * n->s1 + a2 * v3;
            double v2 = n->s2 + a2 * n->s1 + a3 * v3;
            n->s1 = 2.0 * v1 - n->s1;
            n->s2 = 2.0 * v2 - n->s2;
            v = (float)(n->type == N_LP ? v2 : n->type == N_BP ? v1 : x - k * v1 - v2);
            break;
        }
        case N_ADD: v = rd(g, &n->in[0]) + rd(g, &n->in[1]); break;
        case N_SUB: v = rd(g, &n->in[0]) - rd(g, &n->in[1]); break;
        case N_MUL: v = rd(g, &n->in[0]) * rd(g, &n->in[1]); break;
        case N_DIV: { float d = rd(g, &n->in[1]); v = d == 0.f ? 0.f : rd(g, &n->in[0]) / d; break; }
        case N_DRIVE: v = (float)tanh(rd(g, &n->in[0]) * rd(g, &n->in[1])); break;
        case N_MTOF: v = (float)(440.0 * pow(2.0, (rd(g, &n->in[0]) - 69.0) / 12.0)); break;
        case N_SEQ: case N_TRIG: {
            double rate = n->in[0].c;
            int64_t step = (int64_t)floor(g_beat * rate);
            int idx = (int)(((step % n->nsteps) + n->nsteps) % n->nsteps);
            int fire = 0;
            if (!n->inited) {
                n->inited = 1;
                n->last = step;
                /* seq starts on the most recent active step */
                n->hold = 0.f;
                for (int k = 0; k < n->nsteps; k++) {
                    int j = (int)((((int64_t)idx - k) % n->nsteps + n->nsteps) % n->nsteps);
                    if (n->on[j]) { n->hold = n->steps[j]; break; }
                }
            } else if (step != n->last) {
                n->last = step;
                if (n->on[idx]) { fire = 1; n->hold = n->steps[idx]; }
            }
            v = n->type == N_SEQ ? n->hold : (fire ? 1.f : 0.f);
            break;
        }
        case N_AD: {
            /* s2: previous trigger value, s1: stage (0 idle, 1 attack, 2 decay) */
            double trig = rd(g, &n->in[0]);
            double atk = rd(g, &n->in[1]), dec = rd(g, &n->in[2]);
            if (trig > 0.5 && n->s2 <= 0.5) n->s1 = 1;
            n->s2 = trig;
            if (n->s1 == 1) {
                n->ph += atk <= 0 ? 1.0 : 1.0 / (atk * sr);
                if (n->ph >= 1.0) { n->ph = 1.0; n->s1 = 2; }
            } else if (n->s1 == 2) {
                n->ph *= dec <= 0 ? 0.0 : exp(-6.9078 / (dec * sr));
                if (n->ph < 1e-5) { n->ph = 0; n->s1 = 0; }
            }
            v = (float)n->ph;
            break;
        }
        case N_DELAY: {
            float x = rd(g, &n->in[0]);
            double t = rd(g, &n->in[1]) * sr;
            float fb = rd(g, &n->in[2]);
            if (t < 1) t = 1;
            if (t > n->blen - 2) t = n->blen - 2;
            double rp = n->bpos - t;
            if (rp < 0) rp += n->blen;
            int i0 = (int)rp, i1 = i0 + 1 >= n->blen ? 0 : i0 + 1;
            float fr = (float)(rp - i0);
            float d = n->buf[i0] * (1.f - fr) + n->buf[i1] * fr;
            n->buf[n->bpos] = x + fb * d;
            if (++n->bpos >= n->blen) n->bpos = 0;
            v = d;
            break;
        }
        }
        g->val[i] = v;
    }
    *outl = g->outl >= 0 ? g->val[g->outl] : 0.f;
    *outr = g->outr >= 0 ? g->val[g->outr] : 0.f;
}

/* ------------------------------------------------------------ janet glue */

static int sig_get(void *p, Janet key, Janet *out);
static void sig_tostring(void *p, JanetBuffer *buf);

static const JanetAbstractType sig_type = {
    .name = "janey/sig",
    .get = sig_get,
    .tostring = sig_tostring,
};

static Janet wrap_sig(int idx) {
    Sig *s = janet_abstract(&sig_type, sizeof(Sig));
    s->gen = g_bld->gen;
    s->idx = idx;
    return janet_wrap_abstract(s);
}

static void sig_tostring(void *p, JanetBuffer *buf) {
    Sig *s = p;
    janet_buffer_push_cstring(buf, "<sig #");
    char tmp[16];
    snprintf(tmp, sizeof tmp, "%d>", s->idx);
    janet_buffer_push_cstring(buf, tmp);
}

static void need_bld(void) {
    if (!g_bld) janet_panic("signals can only be built while evaluating");
}

static In to_in(Janet v) {
    In in;
    if (janet_checktype(v, JANET_NUMBER)) {
        in.c = (float)janet_unwrap_number(v); in.n = -1;
        return in;
    }
    Sig *s = janet_checkabstract(v, &sig_type);
    if (!s) janet_panicf("expected number or signal, got %v", v);
    if (!g_bld || s->gen != g_bld->gen)
        janet_panic("signal belongs to an earlier evaluation; build it inside the patch (use defn, not def)");
    in.c = 0; in.n = (int16_t)s->idx;
    return in;
}

static const In ZERO = { 0.f, -1 };

static Node *add_node(int type, In a, In b, In c) {
    need_bld();
    if (g_bld->n >= MAXN) janet_panicf("too many nodes (max %d)", MAXN);
    Node *n = &g_bld->nodes[g_bld->n++];
    memset(n, 0, sizeof *n);
    n->type = (uint8_t)type;
    n->in[0] = a; n->in[1] = b; n->in[2] = c;
    n->rng = 0x9e3779b9u + (uint32_t)g_bld->n * 2654435761u;
    return n;
}

static Janet node_janet(int type, In a, In b, In c) {
    add_node(type, a, b, c);
    return wrap_sig(g_bld->n - 1);
}

static In num_in(double v) { In i = { (float)v, -1 }; return i; }

/* arithmetic methods: (+ sig x), (+ x sig) etc. */
static Janet binop(int type, Janet a, Janet b) { return node_janet(type, to_in(a), to_in(b), ZERO); }
static Janet m_add(int32_t argc, Janet *argv)  { janet_fixarity(argc, 2); return binop(N_ADD, argv[0], argv[1]); }
static Janet m_sub(int32_t argc, Janet *argv)  { janet_fixarity(argc, 2); return binop(N_SUB, argv[0], argv[1]); }
static Janet m_rsub(int32_t argc, Janet *argv) { janet_fixarity(argc, 2); return binop(N_SUB, argv[1], argv[0]); }
static Janet m_mul(int32_t argc, Janet *argv)  { janet_fixarity(argc, 2); return binop(N_MUL, argv[0], argv[1]); }
static Janet m_div(int32_t argc, Janet *argv)  { janet_fixarity(argc, 2); return binop(N_DIV, argv[0], argv[1]); }
static Janet m_rdiv(int32_t argc, Janet *argv) { janet_fixarity(argc, 2); return binop(N_DIV, argv[1], argv[0]); }

static const JanetMethod sig_methods[] = {
    {"+", m_add}, {"r+", m_add},
    {"-", m_sub}, {"r-", m_rsub},
    {"*", m_mul}, {"r*", m_mul},
    {"/", m_div}, {"r/", m_rdiv},
    {NULL, NULL}
};

static int sig_get(void *p, Janet key, Janet *out) {
    (void)p;
    if (!janet_checktype(key, JANET_KEYWORD)) return 0;
    return janet_getmethod(janet_unwrap_keyword(key), sig_methods, out);
}

static Janet opt_in(int32_t argc, Janet *argv, int i, double dflt) {
    return i < argc && !janet_checktype(argv[i], JANET_NIL) ? argv[i] : janet_wrap_number(dflt);
}

#define OSC(fname, ty) \
    static Janet fname(int32_t argc, Janet *argv) { \
        janet_fixarity(argc, 1); \
        return node_janet(ty, to_in(argv[0]), ZERO, ZERO); }
OSC(f_sine, N_SINE) OSC(f_saw, N_SAW) OSC(f_square, N_SQUARE) OSC(f_tri, N_TRI)

static Janet f_noise(int32_t argc, Janet *argv) {
    (void)argv; janet_fixarity(argc, 0);
    return node_janet(N_NOISE, ZERO, ZERO, ZERO);
}

#define FILT(fname, ty) \
    static Janet fname(int32_t argc, Janet *argv) { \
        janet_arity(argc, 2, 3); \
        return node_janet(ty, to_in(argv[0]), to_in(argv[1]), to_in(opt_in(argc, argv, 2, 0.707))); }
FILT(f_lpf, N_LP) FILT(f_hpf, N_HP) FILT(f_bpf, N_BP)

static Janet f_drive(int32_t argc, Janet *argv) {
    janet_fixarity(argc, 2);
    return node_janet(N_DRIVE, to_in(argv[0]), to_in(argv[1]), ZERO);
}

static Janet f_mtof(int32_t argc, Janet *argv) {
    janet_fixarity(argc, 1);
    if (janet_checktype(argv[0], JANET_NUMBER))
        return janet_wrap_number(440.0 * pow(2.0, (janet_unwrap_number(argv[0]) - 69.0) / 12.0));
    return node_janet(N_MTOF, to_in(argv[0]), ZERO, ZERO);
}

static Janet seq_common(int type, int32_t argc, Janet *argv) {
    janet_fixarity(argc, 2);
    JanetView v = janet_getindexed(argv, 0);
    double rate = janet_getnumber(argv, 1);
    if (v.len < 1 || v.len > MAXSTEPS) janet_panicf("pattern needs 1..%d steps", MAXSTEPS);
    if (rate <= 0) janet_panic("rate (steps per beat) must be positive");
    Node *n = add_node(type, num_in(rate), ZERO, ZERO);
    n->nsteps = v.len;
    for (int32_t i = 0; i < v.len; i++) {
        Janet s = v.items[i];
        if (janet_checktype(s, JANET_NUMBER)) {
            n->steps[i] = (float)janet_unwrap_number(s);
            n->on[i] = type == N_TRIG ? n->steps[i] != 0.f : 1;
        } else if (janet_checktype(s, JANET_BOOLEAN) && janet_unwrap_boolean(s)) {
            n->steps[i] = 1.f; n->on[i] = 1;
        } else if (janet_checktype(s, JANET_NIL) || janet_checktype(s, JANET_BOOLEAN)) {
            n->on[i] = 0;
        } else janet_panicf("pattern step must be number, true, false or nil, got %v", s);
    }
    return wrap_sig(g_bld->n - 1);
}
static Janet f_seq(int32_t argc, Janet *argv)  { return seq_common(N_SEQ, argc, argv); }
static Janet f_trig(int32_t argc, Janet *argv) { return seq_common(N_TRIG, argc, argv); }

static Janet f_ad(int32_t argc, Janet *argv) {
    janet_arity(argc, 1, 3);
    return node_janet(N_AD, to_in(argv[0]), to_in(opt_in(argc, argv, 1, 0.003)),
                      to_in(opt_in(argc, argv, 2, 0.3)));
}

static Janet f_delay(int32_t argc, Janet *argv) {
    janet_arity(argc, 2, 3);
    Node *n = add_node(N_DELAY, to_in(argv[0]), to_in(argv[1]), to_in(opt_in(argc, argv, 2, 0.4)));
    n->blen = (int)(MAXDELAY_SEC * g_sr) + 2;
    n->buf = calloc((size_t)n->blen, sizeof(float));
    if (!n->buf) janet_panic("out of memory");
    return wrap_sig(g_bld->n - 1);
}

static int node_of(In in) {
    if (in.n >= 0) return in.n;
    add_node(N_ADD, in, ZERO, ZERO); /* constant -> node */
    return g_bld->n - 1;
}

static Janet f_play(int32_t argc, Janet *argv) {
    janet_arity(argc, 1, 2);
    need_bld();
    int l = node_of(to_in(argv[0]));
    int r = argc > 1 ? node_of(to_in(argv[1])) : l;
    g_bld->outl = l; g_bld->outr = r;
    g_played = 1;
    return janet_wrap_nil();
}

static Janet f_bpm(int32_t argc, Janet *argv) {
    janet_arity(argc, 0, 1);
    if (argc == 1) {
        double b = janet_getnumber(argv, 0);
        if (b < 20 || b > 400) janet_panic("bpm must be within 20..400");
        g_bpm = b;
    }
    return janet_wrap_number(g_bpm);
}

static Janet f_beats(int32_t argc, Janet *argv) {
    janet_fixarity(argc, 1);
    return janet_wrap_number(janet_getnumber(argv, 0) * 60.0 / g_bpm);
}

static Janet f_sample_rate(int32_t argc, Janet *argv) {
    (void)argv; janet_fixarity(argc, 0);
    return janet_wrap_number(g_sr);
}

static const JanetReg cfuns[] = {
    {"sine", f_sine, "(sine freq)\n\nSine oscillator, -1..1."},
    {"saw", f_saw, "(saw freq)\n\nBand-limited saw oscillator."},
    {"square", f_square, "(square freq)\n\nBand-limited square oscillator."},
    {"tri", f_tri, "(tri freq)\n\nTriangle oscillator."},
    {"noise", f_noise, "(noise)\n\nWhite noise."},
    {"lpf", f_lpf, "(lpf sig cutoff &opt q)\n\nResonant low-pass filter."},
    {"hpf", f_hpf, "(hpf sig cutoff &opt q)\n\nResonant high-pass filter."},
    {"bpf", f_bpf, "(bpf sig cutoff &opt q)\n\nBand-pass filter."},
    {"drive", f_drive, "(drive sig amount)\n\ntanh waveshaper."},
    {"mtof", f_mtof, "(mtof note)\n\nMIDI note to Hz; works on numbers and signals."},
    {"seq", f_seq, "(seq steps rate)\n\nHolds the value of the current step; steps per beat = rate. nil rests."},
    {"trig", f_trig, "(trig steps rate)\n\nOne-sample pulse at the start of each active step."},
    {"ad", f_ad, "(ad trig &opt attack decay)\n\nAttack/decay envelope fired by a trigger."},
    {"delay", f_delay, "(delay sig seconds &opt feedback)\n\nFeedback delay (wet signal only)."},
    {"play", f_play, "(play left &opt right)\n\nSet the patch output."},
    {"bpm", f_bpm, "(bpm &opt value)\n\nGet or set the tempo."},
    {"beats", f_beats, "(beats n)\n\nSeconds in n beats at the current tempo."},
    {"sample-rate", f_sample_rate, "(sample-rate)\n\nAudio sample rate."},
    {NULL, NULL, NULL}
};

static const char *prelude =
    "(defn rescale \"Map a -1..1 signal onto lo..hi.\" [s lo hi]\n"
    "  (+ lo (* (+ 0.5 (* 0.5 s)) (- hi lo))))\n"
    "(defn mix \"Average signals.\" [& sigs] (/ (+ ;sigs) (length sigs)))\n"
    "(defn pan-l [s p] (* s (- 1 p)))\n"
    "(defn pan-r [s p] (* s p))\n";

/* ---------------------------------------------------------------- exports */

EXPORT("janey_init")
int janey_init(float sample_rate) {
    g_sr = sample_rate;
    janet_init();
    g_env = janet_core_env(NULL);
    janet_gcroot(janet_wrap_table(g_env));
    janet_cfuns(g_env, NULL, cfuns);
    Janet out;
    return janet_dostring(g_env, prelude, "prelude", &out);
}

static void set_result(const char *s) {
    g_result_len = (int)strlen(s);
    if (g_result_len >= (int)sizeof g_result) g_result_len = sizeof g_result - 1;
    memcpy(g_result, s, (size_t)g_result_len);
    g_result[g_result_len] = 0;
}

/* Evaluate source. Returns 0 on success (patch swapped in if it called play),
 * 1 on error, 2 on success without a play call. Message via janey_result. */
EXPORT("janey_eval")
int janey_eval(const char *src, int len) {
    g_bld = graph_new();
    if (!g_bld) { set_result("out of memory"); return 1; }
    g_played = 0;
    Janet out = janet_wrap_nil();
    int sig = janet_dobytes(g_env, (const uint8_t *)src, len, "live", &out);
    int status;
    if (sig != 0) {
        const uint8_t *s = janet_to_string(out);
        char buf[sizeof g_result];
        snprintf(buf, sizeof buf, "%.*s", (int)janet_string_length(s), (const char *)s);
        set_result(buf);
        graph_free(g_bld);
        status = 1;
    } else if (!g_played) {
        const uint8_t *s = janet_description(out);
        char buf[sizeof g_result];
        snprintf(buf, sizeof buf, "%.*s", (int)janet_string_length(s), (const char *)s);
        set_result(buf);
        graph_free(g_bld);
        status = 2;
    } else {
        graph_free(g_prev);
        g_prev = g_cur;
        g_cur = g_bld;
        g_fade_len = g_fade_left = (int)(FADE_SEC * g_sr);
        set_result("ok");
        status = 0;
    }
    g_bld = NULL;
    fflush(stdout);
    fflush(stderr);
    return status;
}

/* Fade the current patch out. */
EXPORT("janey_silence")
void janey_silence(void) {
    graph_free(g_prev);
    g_prev = g_cur;
    g_cur = NULL;
    g_fade_len = g_fade_left = (int)(FADE_SEC * g_sr);
}

EXPORT("janey_render")
void janey_render(int frames) {
    if (frames > MAXBLOCK) frames = MAXBLOCK;
    for (int i = 0; i < frames; i++) {
        float cl = 0, cr = 0, pl = 0, pr = 0;
        if (g_cur) graph_tick(g_cur, &cl, &cr);
        if (g_prev) graph_tick(g_prev, &pl, &pr);
        float t = g_fade_left > 0 ? (float)g_fade_left / (float)g_fade_len : 0.f;
        float l = cl * (1.f - t) + pl * t;
        float r = cr * (1.f - t) + pr * t;
        if (g_fade_left > 0 && --g_fade_left == 0) { graph_free(g_prev); g_prev = NULL; }
        g_beat += g_bpm / (60.0 * g_sr);
        l = tanhf(l); r = tanhf(r);
        g_outl[i] = l; g_outr[i] = r;
    }
}

EXPORT("janey_out_l") float *janey_out_l(void) { return g_outl; }
EXPORT("janey_out_r") float *janey_out_r(void) { return g_outr; }
EXPORT("janey_result") const char *janey_result(void) { return g_result; }
EXPORT("janey_result_len") int janey_result_len(void) { return g_result_len; }
EXPORT("janey_beat") double janey_beat(void) { return g_beat; }
EXPORT("janey_alloc") void *janey_alloc(int n) { return malloc((size_t)n); }
EXPORT("janey_free") void janey_free(void *p) { free(p); }
