#!/usr/bin/env bash
# Builds web/janey.wasm: the Janet VM plus the janey DSP core, as a standalone
# WASI "reactor" module (no Emscripten needed).
#
# Needs: git, make, a C compiler (to bootstrap Janet's amalgamation), curl, tar.
# Downloads Janet and wasi-sdk into ./build (git-ignored) on first run.
set -euo pipefail

JANET_TAG="${JANET_TAG:-v1.37.1}"
WASI_VER="${WASI_VER:-25}"

root="$(cd "$(dirname "$0")" && pwd)"
build="$root/build"
mkdir -p "$build"

# --- Janet source + amalgamation (native bootstrap) -------------------------
if [ ! -d "$build/janet" ]; then
  git clone --quiet --depth 1 --branch "$JANET_TAG" https://github.com/janet-lang/janet.git "$build/janet"
fi
if [ ! -f "$build/janet/build/c/janet.c" ] || [ ! -f "$build/janet/build/janet.h" ]; then
  make -C "$build/janet" -j"$(nproc 2>/dev/null || echo 4)" build/c/janet.c build/janet.h
fi

# --- wasi-sdk ----------------------------------------------------------------
sdk="${WASI_SDK_PATH:-$build/wasi-sdk}"
if [ ! -x "$sdk/bin/clang" ]; then
  arch="$(uname -m | sed 's/aarch64/arm64/')"
  os="$(uname -s | tr A-Z a-z | sed 's/darwin/macos/')"
  mkdir -p "$sdk"
  curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_VER/wasi-sdk-$WASI_VER.0-$arch-$os.tar.gz" \
    | tar xz --strip-components=1 -C "$sdk"
fi

# --- compile -----------------------------------------------------------------
mkdir -p "$build/inc/sys"
cp "$build/janet/build/janet.h" "$build/inc/janet.h"
# WASI has no sys/wait.h or spawn.h; Janet only needs them for process support, which is off.
printf '#define WEXITSTATUS(x) (x)\n' > "$build/inc/sys/wait.h"
printf '/* intentionally empty */\n' > "$build/inc/spawn.h"

# Janet features that make no sense (or don't exist) in a browser sandbox.
defs=(
  -DJANET_NO_DYNAMIC_MODULES -DJANET_NO_PROCESSES -DJANET_NO_NET -DJANET_NO_EV
  -DJANET_SINGLE_THREADED -DJANET_NO_THREADS -DJANET_NO_FFI -DJANET_NO_FFI_JIT -DJANET_NO_FILEWATCH
  -DJANET_NO_REALPATH -DJANET_NO_SYMLINKS -DJANET_NO_UMASK -DJANET_NO_CRYPTORAND
  -DJANET_NO_ASSEMBLER -DJANET_NO_INTERPRETER_INTERRUPT
)

# setjmp/longjmp (Janet's error handling) lowers to wasm exception handling.
flags=(
  --sysroot "$sdk/share/wasi-sysroot" -O2 -std=gnu99 -D_DEFAULT_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS
  -mexec-model=reactor -mexception-handling -mllvm -wasm-enable-sjlj
  -include "$root/src/wasi_compat.h" -I"$build/inc" "${defs[@]}"
)

mkdir -p "$root/web"
"$sdk/bin/clang" "${flags[@]}" \
  "$build/janet/build/c/janet.c" "$root/src/dsp.c" "$root/src/wasi_stubs.c" \
  -lsetjmp -lwasi-emulated-signal -lwasi-emulated-process-clocks \
  -Wl,-z,stack-size=1048576 -Wl,--initial-memory=33554432 -Wl,--max-memory=268435456 \
  -Wl,--strip-all -Wl,--gc-sections \
  -o "$root/web/janey.wasm"

ls -l "$root/web/janey.wasm"
