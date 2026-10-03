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

/* POSIX errno names are stable across hosts; numeric errno values are not. */
static const char *errno_code(int error_number) {
  switch (error_number) {
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    default: return "";
  }
}

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
  int error_number = errno;
  if (error_number == EEXIST) {
    fprintf(stderr, "destination_exists: The move destination already exists\n");
    return 17;
  }
  if (error_number == ENOSYS || error_number == EOPNOTSUPP || error_number == EINVAL) {
    fprintf(stderr, "atomic_move_unavailable: The filesystem lacks atomic no-replace rename\n");
    return 78;
  }
  fprintf(stdout, "%s", errno_code(error_number));
  fprintf(stderr, "atomic_move_failed: %s\n", strerror(error_number));
  return 1;
}
