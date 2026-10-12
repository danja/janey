// Starter patches. Every one of these is evaluated by test/examples.test.mjs.
export const examples = {
  'hello sine': `# Ctrl+Enter evaluates. A patch is whatever you hand to (play).
(play (* 0.2 (sine 220)))
`,

  'techno': `(bpm 128)

# Everything below is 16 steps per bar, four steps per beat (rate 4),
# except the pad, which is just a held chord.

# --- drums ---
(def kick-env (ad (trig [1 nil nil nil 1 nil nil nil 1 nil nil nil 1 nil nil nil] 4) 0.001 0.3))
(def kick (* kick-env (sine (+ 42 (* 140 kick-env)))))

# closed hats tick on the 16ths and leave the offbeat free for the open hat
(def hat (* 0.18 (hpf (noise) 8000)
            (ad (trig [1 nil nil 1 1 nil nil 1 1 nil nil 1 1 nil nil 1] 4) 0.001 0.04)))

# open hat on every offbeat
(def open-hat (* 0.2 (hpf (noise) 6500)
                 (ad (trig [nil nil 1 nil nil nil 1 nil nil nil 1 nil nil nil 1 nil] 4) 0.002 0.22)))

(def clap (* 0.3 (bpf (noise) 1800 1.5)
             (ad (trig [nil nil nil nil 1 nil nil nil nil nil nil nil 1 nil nil nil] 4) 0.002 0.14)))

# syncopated conga-ish blips
(def perc-env (ad (trig [nil nil nil 1 nil nil 1 nil nil 1 nil nil nil 1 nil 1] 4) 0.001 0.09))
(def perc (* 0.3 perc-env (sine (+ 330 (* 220 perc-env)))))

# --- bass: eight steps at 16th-note rate, so the line loops every two beats ---
(def bass
  (let [env (ad (trig [1 1 1 1 1 1 1 1] 4) 0.002 0.12)]
    (* 0.5 env (lpf (saw (mtof (seq [36 36 36 48 36 36 39 43] 4)))
                    (+ 150 (* 1800 env)) 3))))

# --- pad: a C minor 9 chord, detuned saws under a slowly breathing filter ---
(defn voice [note detune]
  (saw (* (mtof note) detune)))
(def pad
  (* 0.05 (lpf (+ (voice 48 1.0) (voice 48 1.006)
                  (voice 51 1.0) (voice 55 0.996)
                  (voice 58 1.004) (voice 62 0.997))
               (rescale (sine 0.06) 500 1600) 1.2)))

# --- arp: a square lead over the same key, with a dotted-eighth echo ---
(def arp-env (ad (trig [1 1 1 nil 1 1 nil 1] 4) 0.002 0.1))
(def arp (* arp-env (lpf (square (mtof (seq [72 75 79 82 79 75 79 75] 4)))
                         (+ 1200 (* 2800 arp-env)) 2)))

(play (+ (* 0.9 kick) hat open-hat clap perc bass pad
         (* 0.12 arp)
         (delay (* 0.12 arp) (beats 0.75) 0.4)))
`,

  'acid line': `(bpm 124)

(def pitch (mtof (seq [36 36 48 36 39 36 51 43 36 36 48 34 39 36 55 43] 4)))
(def env   (ad (trig [1 1 1 nil 1 1 nil 1 1 1 1 nil 1 nil 1 1] 4) 0.002 0.16))
(def sweep (rescale (sine 0.08) 400 2400))

(def line (drive (lpf (saw pitch) (+ 200 (* 0.6 sweep env) (* 0.2 sweep)) 7) 2.5))

# ping-pong-ish: slightly different delay times left and right
(play (+ (* 0.35 env line) (delay (* 0.2 env line) (beats 0.75) 0.45))
      (+ (* 0.35 env line) (delay (* 0.2 env line) (beats 0.5) 0.45)))
`,

  'slow pad': `(bpm 70)

(defn voice [note detune]
  (lpf (saw (* (mtof note) detune)) (rescale (sine 0.07) 500 1800) 1.2))

(play (* 0.25 (mix (voice 57 1.0) (voice 57 1.005)
                   (voice 60 1.0) (voice 60 0.995)
                   (voice 64 1.0) (voice 64 1.004)
                   (voice 67 1.0) (voice 67 0.996)))
      (* 0.25 (delay (mix (voice 52 1.0) (voice 60 1.003) (voice 64 0.997)) (beats 1.5) 0.6)))
`,
};
