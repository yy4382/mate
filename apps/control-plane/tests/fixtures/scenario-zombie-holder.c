// Keep an actually exited scenario service observable until the test releases stdin.
#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  pid_t child = fork();
  if (child < 0) return 3;
  if (child == 0) {
    execvp(argv[1], &argv[1]);
    _exit(127);
  }
  siginfo_t result;
  while (waitid(P_PID, child, &result, WEXITED | WNOWAIT) < 0) {
    if (errno != EINTR) return 4;
  }
  printf("MATE_ZOMBIE_READY %ld %d\n", (long)child, result.si_status);
  fflush(stdout);
  char release;
  while (read(STDIN_FILENO, &release, 1) < 0 && errno == EINTR) {}
  while (waitpid(child, NULL, 0) < 0) {
    if (errno != EINTR) return 5;
  }
  return 0;
}
