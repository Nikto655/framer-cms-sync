# Opens the terminal app as soon as someone opens an interactive shell in the container:
# `docker exec -it <container> sh` (or bash), and Docker Desktop's Exec tab.
# Quit the app (q) to get the shell. Set FRAMER_CMS_SYNC_NO_TUI=1 to skip it.
case $- in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
if [ -t 0 ] && [ -t 1 ] && [ -z "${FRAMER_CMS_SYNC_NO_TUI:-}" ] && [ -z "${FRAMER_CMS_SYNC_IN_SHELL:-}" ]; then
  export FRAMER_CMS_SYNC_IN_SHELL=1
  cd /config 2>/dev/null || true
  framer-cms-sync
  echo "You're in the container's shell. Run framer-cms-sync to open the app again."
fi
