/* Force-included when compiling Janet for wasm32-wasi (see build.sh).
 * wasi-libc lacks a couple of POSIX bits Janet's os module references. */
#ifndef JANEY_WASI_COMPAT_H
#define JANEY_WASI_COMPAT_H
#include <time.h>
static inline void tzset(void) {}
#ifndef CLOCK_PROCESS_CPUTIME_ID
#define CLOCK_PROCESS_CPUTIME_ID CLOCK_MONOTONIC
#endif
#endif
