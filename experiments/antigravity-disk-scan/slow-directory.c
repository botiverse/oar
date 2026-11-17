#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

/* Only the fixture's du process loads this library. It delays metadata reads
 * instead of creating millions of files or traversing the machine's home. */
static void pause_entry(void) {
  struct timespec delay = {0, 60000000};
  nanosleep(&delay, NULL);
}
__attribute__((constructor)) static void observe(void) {
  const char *file = getenv("OAR_DU_TRACE");
  if (file == NULL) return;
  int fd = open(file, O_CREAT | O_WRONLY | O_APPEND, 0600);
  if (fd < 0) return;
  dprintf(fd, "%d\n", getpid());
  close(fd);
}
struct dirent *readdir(DIR *dir) {
  static struct dirent *(*next)(DIR *);
  if (next == NULL) next = dlsym(RTLD_NEXT, "readdir");
  struct dirent *entry = next(dir);
  if (entry != NULL) pause_entry();
  return entry;
}
struct dirent64 *readdir64(DIR *dir) {
  static struct dirent64 *(*next)(DIR *);
  if (next == NULL) next = dlsym(RTLD_NEXT, "readdir64");
  struct dirent64 *entry = next(dir);
  if (entry != NULL) pause_entry();
  return entry;
}
