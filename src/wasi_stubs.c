/* Link-time stubs for libc functions WASI declares but does not implement. */
#include <stdio.h>
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
FILE *tmpfile(void) { return NULL; }
