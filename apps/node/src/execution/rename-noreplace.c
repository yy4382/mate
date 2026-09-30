#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#ifdef __APPLE__
#include <sys/stdio.h>
#else
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif
#endif

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "Usage: rename-noreplace SOURCE_NAME DESTINATION_NAME\n");
    return 64;
  }

  int result;
#ifdef __APPLE__
  result = renameatx_np(3, argv[1], 4, argv[2], RENAME_EXCL);
#elif defined(__linux__)
  result = renameat2(3, argv[1], 4, argv[2], RENAME_NOREPLACE);
#else
  fprintf(stderr, "Atomic no-replace rename is unavailable on this platform\n");
  return 78;
#endif

  if (result == 0) return 0;
  if (errno == EEXIST) {
    fprintf(stderr, "destination_exists: The move destination already exists\n");
    return 17;
  }
  if (errno == ENOSYS || errno == EOPNOTSUPP || errno == EINVAL) {
    fprintf(stderr, "atomic_move_unavailable: The filesystem lacks atomic no-replace rename\n");
    return 78;
  }
  fprintf(stderr, "atomic_move_failed: %s\n", strerror(errno));
  return 1;
}
