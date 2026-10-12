// Starter patches. Every one of these is evaluated by test/examples.test.mjs.
export const examples = {
  'hello sine': `# Ctrl+Enter evaluates. A patch is whatever you hand to (play).
(play (* 0.2 (sine 220)))
`,

  'techno': `(bpm 128)

# sixteen steps, four per beat
(def kick-env (ad (trig [1 nil nil nil 1 nil nil nil 1 nil nil nil 1 nil nil nil] 4) 0.001 0.3))
(def kick (* kick-env (sine (+ 42 (* 140 kick-env)))))

(def hat (* 0.25 (hpf (noise) 8000)
            (ad (trig [nil nil 1 nil nil nil 1 nil nil nil 1 nil nil nil 1 1] 4) 0.001 0.05)))

(def clap (* 0.3 (bpf (noise) 1800 1.5)
             (ad (trig [nil nil nil nil 1 nil nil nil nil nil nil nil 1 nil nil nil] 4) 0.002 0.14)))

(def bass
  (let [env (ad (trig [1 1 1 1 1 1 1 1] 2) 0.002 0.2)]
    (* 0.5 env (lpf (saw (mtof (seq [36 36 36 48 36 36 39 43] 2)))
                    (+ 150 (* 1800 env)) 3))))

(play (+ (* 0.9 kick) hat clap bass))
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
