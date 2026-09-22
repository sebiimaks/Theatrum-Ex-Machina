#define _DARWIN_C_SOURCE
#define _XOPEN_SOURCE 700
#define _DEFAULT_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/mount.h>
#elif defined(__linux__)
#include <sys/vfs.h>
#include <linux/magic.h>
#endif

static int local_filesystem(int directory) {
  struct statfs info;
  if (fstatfs(directory, &info) != 0) return 0;
#ifdef __APPLE__
  return (info.f_flags & MNT_LOCAL) != 0;
#elif defined(__linux__)
  /* Deliberately conservative: unlisted/FUSE/network filesystems are rejected.
   * ext2/3/4 share EXT2_SUPER_MAGIC. More filesystems require separate testing. */
  return info.f_type == EXT2_SUPER_MAGIC || info.f_type == XFS_SUPER_MAGIC
    || info.f_type == BTRFS_SUPER_MAGIC || info.f_type == TMPFS_MAGIC
    || info.f_type == OVERLAYFS_SUPER_MAGIC;
#else
  (void)directory;
  return 0;
#endif
}

/* Never unlink the lock: all contenders must flock the same persistent inode.
 * No passwords, keys or media are passed to this helper. Parent death closes
 * stdin and its shared descriptor; EOF closes the helper's final reference.
 * Helper death alone leaves the parent's shared lock held until its IO drains.
 * Never call LOCK_UN: that would unlock both shared references prematurely. */
static int same_file(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static int fail(void) {
  puts("ERROR");
  fflush(stdout);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 4) return fail();
  char *canonical = realpath(argv[1], NULL);
  if (!canonical || strcmp(canonical, argv[1]) != 0) {
    free(canonical);
    return fail();
  }
  free(canonical);
  char *end_dev = NULL, *end_ino = NULL;
  errno = 0;
  uintmax_t expected_dev = strtoumax(argv[2], &end_dev, 10);
  uintmax_t expected_ino = strtoumax(argv[3], &end_ino, 10);
  if (errno || !end_dev || *end_dev || !end_ino || *end_ino) return fail();
  int directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat root, current, owned;
  if (directory < 0 || fstat(directory, &root) != 0 || !S_ISDIR(root.st_mode)
      || (uintmax_t)root.st_dev != expected_dev || (uintmax_t)root.st_ino != expected_ino) return fail();
  if (!local_filesystem(directory)) {
    puts("UNSUPPORTED_FS");
    fflush(stdout);
    return 3;
  }
  const int lock = 3; /* Inherited duplicate of the parent's retained handle. */
  if (fcntl(lock, F_SETFD, FD_CLOEXEC) != 0 || fstat(lock, &owned) != 0 || !S_ISREG(owned.st_mode)
      || owned.st_nlink != 1 || owned.st_size != 0 || owned.st_uid != geteuid()
      || (owned.st_mode & 077) != 0) return fail();
  if (flock(lock, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) {
      puts("BUSY");
      fflush(stdout);
      return 2;
    }
    return fail();
  }
  if (fstatat(directory, ".private-hub.lock", &current, AT_SYMLINK_NOFOLLOW) != 0
      || !same_file(&current, &owned) || current.st_nlink != 1 || !S_ISREG(current.st_mode)
      || lstat(argv[1], &current) != 0 || !same_file(&root, &current) || !S_ISDIR(current.st_mode)) return fail();
  if (printf("READY %ju %ju\n", (uintmax_t)owned.st_dev, (uintmax_t)owned.st_ino) < 0
      || fflush(stdout) != 0) return 1;
  char byte;
  ssize_t count;
  do {
    count = read(STDIN_FILENO, &byte, 1);
  } while (count < 0 && errno == EINTR);
  /* Only EOF is a normal helper exit. The parent retains its shared lock
   * reference until queued IO drains, including on unexpected input. */
  close(lock);
  close(directory);
  return count == 0 ? 0 : 1;
}
