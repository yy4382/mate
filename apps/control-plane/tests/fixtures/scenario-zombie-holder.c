// Keep an actually exited scenario service observable until the test releases stdin.
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t stopping = 0;
static volatile sig_atomic_t service_pid = 0;

static void stop_service(int signal_number) {
  (void)signal_number;
  int saved_errno = errno;
  stopping = 1;
  // This is only the direct child forked by this fixture, still held by waitid.
  if (service_pid > 0) kill(service_pid, SIGKILL);
  errno = saved_errno;
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  struct sigaction action = {0};
  action.sa_handler = stop_service;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) < 0 || sigaction(SIGINT, &action, NULL) < 0) return 6;
  pid_t child = fork();
  if (child < 0) return 3;
  if (child == 0) {
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    execvp(argv[1], &argv[1]);
    _exit(127);
  }
  service_pid = child;
  if (stopping) kill(child, SIGKILL);
  printf("MATE_CHILD_STARTED %ld\n", (long)child);
  fflush(stdout);
  siginfo_t result;
  while (waitid(P_PID, child, &result, WEXITED | WNOWAIT) < 0) {
    if (errno != EINTR) return 4;
  }
  // The child is now exited and unreaped; never signal a PID after waitpid releases it.
  service_pid = 0;
  printf("MATE_ZOMBIE_READY %ld %d\n", (long)child, result.si_status);
  fflush(stdout);
  char release;
  if (!stopping) {
    while (read(STDIN_FILENO, &release, 1) < 0 && errno == EINTR && !stopping) {}
  }
  while (waitpid(child, NULL, 0) < 0) {
    if (errno != EINTR) return 5;
  }
  return 0;
}
