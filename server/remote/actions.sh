# Shift action helpers (run as root). Requires lib.sh. SHIFT_W = job work dir, SHIFT_BK = backup dir.
W=${SHIFT_W:?}
BK=${SHIFT_BK:?}
os_detect; pm_detect
mkdir -p "$W/pub" "$BK" && chmod 711 "$W" && chmod 755 "$W/pub" && chmod 700 "$BK"

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
b64d() { printf '%s' "$1" | base64 -d; }

# step "title" cmd args...   ->  @@STEP <b64 title> ... @@OK | @@FAIL rc
step() {
  _title=$1; shift
  printf '@@STEP %s\n' "$(printf '%s' "$_title" | base64 | tr -d '\n')"
  "$@"; _rc=$?
  if [ $_rc -eq 0 ]; then echo "@@OK"; else echo "@@FAIL $_rc"; fi
  return $_rc
}

backup_file() { # backup_file PATH  (keeps the first backup only)
  [ -e "$1" ] || [ -L "$1" ] || return 0
  _d="$BK/files$(dirname "$1")"; mkdir -p "$_d"
  [ -e "$_d/$(basename "$1")" ] || [ -L "$_d/$(basename "$1")" ] || cp -a "$1" "$_d/"
}
restore_file() { # restore_file PATH
  _s="$BK/files$1"
  if [ -e "$_s" ] || [ -L "$_s" ]; then mkdir -p "$(dirname "$1")"; rm -rf "$1"; cp -a "$_s" "$1"; fi
}

# ---------------- packages / system ----------------
act_pkgs() { pkg_install "$@" || { PM_UPDATED=; pkg_update; pkg_install "$@"; }; }
act_pkgs_try() { pkg_try "$@"; }
act_epel() {
  case $OS_ID in rocky|almalinux|centos|ol|rhel) rpm -q epel-release >/dev/null 2>&1 || pkg_install epel-release || \
    pkg_install "https://dl.fedoraproject.org/pub/epel/epel-release-latest-$(echo "$OS_VER" | cut -d. -f1).noarch.rpm" ;; esac
  return 0
}
act_tz() {
  [ -f "/usr/share/zoneinfo/$1" ] || { log "timezone $1 not available"; return 0; }
  if has_systemd && have timedatectl; then timedatectl set-timezone "$1" 2>/dev/null && return 0; fi
  ln -sf "/usr/share/zoneinfo/$1" /etc/localtime; [ -f /etc/timezone ] && echo "$1" > /etc/timezone; return 0
}
act_cron_service() {
  if have crontab && { proc_running cron || proc_running crond; }; then return 0; fi
  case $OS_FAMILY in debian) pkg_install cron ;; rhel|arch|suse) pkg_install cronie ;; alpine) true ;; *) pkg_install cron ;; esac
  _s=$(svc_first cron crond cronie) || { have crond && crond; return 0; }
  svc enable "$_s"; svc start "$_s" 2>/dev/null || svc restart "$_s"; return 0
}

# ---------------- users ----------------
act_group() { # NAME GID
  group_exists "$1" && return 0
  _free=1; awk -F: -v g="$2" '$3==g{f=1} END{exit !f}' /etc/group && _free=
  if have groupadd; then if [ -n "$_free" ] && [ -n "$2" ]; then groupadd -g "$2" "$1"; else groupadd "$1"; fi
  else if [ -n "$_free" ] && [ -n "$2" ]; then addgroup -g "$2" "$1"; else addgroup "$1"; fi; fi
}
act_user() { # NAME UID GROUP HOME SHELL SUPGROUPS(csv)
  _n=$1 _uid=$2 _g=$3 _h=$4 _sh=$5 _sup=$6
  [ -x "$_sh" ] || _sh=/bin/sh
  if ! user_exists "$_n"; then
    _free=1; awk -F: -v u="$_uid" '$3==u{f=1} END{exit !f}' /etc/passwd && _free=
    if have useradd; then
      if [ -n "$_free" ]; then useradd -M -u "$_uid" -g "$_g" -d "$_h" -s "$_sh" "$_n"; else useradd -M -g "$_g" -d "$_h" -s "$_sh" "$_n"; fi
    else
      if [ -n "$_free" ]; then adduser -D -H -u "$_uid" -G "$_g" -h "$_h" -s "$_sh" "$_n"; else adduser -D -H -G "$_g" -h "$_h" -s "$_sh" "$_n"; fi
    fi || return 1
  fi
  [ -d "$_h" ] || { mkdir -p "$_h" && chown "$_n:$_g" "$_h" && chmod 750 "$_h"; }
  for _sg in $(echo "$_sup" | tr ',' ' '); do
    group_exists "$_sg" || continue
    if have usermod; then usermod -aG "$_sg" "$_n" 2>/dev/null; else addgroup "$_n" "$_sg" 2>/dev/null; fi
  done
  return 0
}
act_authkeys() { # USER FILE  — merge (never replace) SSH login keys
  _h=$(pw_home "$1"); [ -n "$_h" ] && [ -f "$2" ] || return 0
  mkdir -p "$_h/.ssh"; touch "$_h/.ssh/authorized_keys"
  while IFS= read -r _l; do
    case $_l in ""|"#"*|*shift-job-*) continue ;; esac
    grep -qxF "$_l" "$_h/.ssh/authorized_keys" || printf '%s\n' "$_l" >> "$_h/.ssh/authorized_keys"
  done < "$2"
  chown "$1:$(user_group "$1")" "$_h/.ssh" "$_h/.ssh/authorized_keys"; chmod 700 "$_h/.ssh"; chmod 600 "$_h/.ssh/authorized_keys"
  have restorecon && restorecon -R "$_h/.ssh" 2>/dev/null; return 0
}

# ---------------- node ----------------
node_arch() {
  case $(uname -m) in x86_64|amd64) echo x64 ;; aarch64|arm64) echo arm64 ;; armv7l) echo armv7l ;; ppc64le) echo ppc64le ;; s390x) echo s390x ;; *) return 1 ;; esac
}
act_node() { # VERSION(vX.Y.Z) PREFIX
  _v=$1 _p=$2
  if [ -x "$_p/bin/node" ] && [ "$("$_p/bin/node" -v 2>/dev/null)" = "$_v" ]; then log "Node.js $_v ready at $_p"; return 0; fi
  _a=$(node_arch) || { log "Unsupported CPU $(uname -m) for Node.js"; return 1; }
  if [ "$(libc_kind)" = musl ]; then _u="https://unofficial-builds.nodejs.org/download/release/$_v/node-$_v-linux-$_a-musl.tar.gz"
  else _u="https://nodejs.org/dist/$_v/node-$_v-linux-$_a.tar.gz"; fi
  log "Installing Node.js $_v into $_p"
  _t=$(mktemp -d); dl "$_u" "$_t/n.tgz" || { rm -rf "$_t"; log "Download failed: $_u"; return 1; }
  mkdir -p "$_p" && tar -xzf "$_t/n.tgz" -C "$_p" --strip-components=1 --no-same-owner \
     --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' 2>/dev/null || \
     tar -xzf "$_t/n.tgz" -C "$_p" --strip-components=1 || { rm -rf "$_t"; return 1; }
  rm -rf "$_t"
  [ "$("$_p/bin/node" -v 2>/dev/null)" = "$_v" ]
}
act_link() { # TARGET LINKPATH  (only replaces missing/broken links)
  if [ -e "$2" ] && [ "$(readlink -f "$2")" = "$(readlink -f "$1")" ]; then return 0; fi
  if [ -e "$2" ] || [ -L "$2" ]; then mv "$2" "$2.shift-orig.$(date +%s)"; fi
  mkdir -p "$(dirname "$2")"; ln -s "$1" "$2"
}
act_npmg() { # NODEBIN PKG@VER...
  _d=$(dirname "$1"); shift
  PATH="$_d:$PATH" "$_d/npm" install -g --no-fund --no-audit --loglevel=error "$@"
}
act_node_rebuild() { # DIR OWNER NODEBIN
  _d=$(dirname "$3")
  [ -d "$1/node_modules" ] || return 0
  log "Rebuilding native Node modules in $1"
  as_user "$2" "cd $(q "$1") && PATH=$(q "$_d"):\$PATH npm rebuild --loglevel=error" && return 0
  if [ -f "$1/package-lock.json" ]; then as_user "$2" "cd $(q "$1") && PATH=$(q "$_d"):\$PATH npm ci --no-fund --no-audit --loglevel=error"; else return 1; fi
}

# ---------------- python ----------------
act_uv() {
  [ -x /usr/local/bin/uv ] && return 0
  dl https://astral.sh/uv/install.sh /tmp/shift-uv.sh || return 1
  env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 INSTALLER_NO_MODIFY_PATH=1 sh /tmp/shift-uv.sh -q >/dev/null 2>&1
  rm -f /tmp/shift-uv.sh; [ -x /usr/local/bin/uv ]
}
py_ok() { # INTERP MAJOR.MINOR REQFILE OWNER CWD -> 0 if same version and all packages present
  [ -x "$1" ] || return 1
  _mm=$(as_user "$4" "cd $(q "$5") 2>/dev/null; $(q "$1") -c 'import sys;print(\"%d.%d\"%sys.version_info[:2])'" 2>/dev/null)
  [ "$_mm" = "$2" ] || { log "Python at $1 is ${_mm:-missing}, need $2"; return 1; }
  [ -s "$3" ] || return 0
  as_user "$4" "cd $(q "$5") 2>/dev/null; $(q "$1") $(q "$W/pub/pycheck.py") $(q "$3")"
}
py_install() { # PY REQ OPTIONAL
  _fail=
  [ -s "$2" ] && { /usr/local/bin/uv pip install -q --python "$1" -r "$2" 2>/dev/null || {
    log "Bulk install failed, installing packages one by one"
    while IFS= read -r _l; do [ -n "$_l" ] || continue
      /usr/local/bin/uv pip install -q --python "$1" "$_l" 2>/dev/null || /usr/local/bin/uv pip install -q --python "$1" "${_l%%==*}" 2>/dev/null || _fail="$_fail ${_l%%==*}"
    done < "$2"
    if [ -n "$_fail" ]; then
      log "Installing build tools and retrying:$_fail"
      case $OS_FAMILY in debian) pkg_try build-essential ;; rhel) pkg_try gcc gcc-c++ make ;; alpine) pkg_try build-base ;; arch) pkg_try base-devel ;; esac
      _f2=; for _n in $_fail; do grep -i "^$_n==" "$2" | head -n1 | while read -r _l; do /usr/local/bin/uv pip install -q --python "$1" "$_l" 2>/dev/null || /usr/local/bin/uv pip install -q --python "$1" "$_n" 2>/dev/null || echo "$_n"; done; done > "$W/pub/pyfail"
      _fail=$(cat "$W/pub/pyfail" | tr '\n' ' ')
    fi; }; }
  [ -s "$3" ] && while IFS= read -r _l; do [ -n "$_l" ] && /usr/local/bin/uv pip install -q --python "$1" "$_l" >/dev/null 2>&1; done < "$3"
  [ -n "$(echo $_fail)" ] && echo "@@WARN $(printf 'Python packages that could not be installed: %s' "$_fail" | base64 | tr -d '\n')"
  return 0
}
act_pyfix() { # INTERP VERSION(X.Y.Z) VENVDIR(or -) OWNER CWD REQ OPT NEWVENV
  _py=$1 _ver=$2 _venv=$3 _own=$4 _cwd=$5 _req=$6 _opt=$7 _new=$8
  _mm=$(echo "$_ver" | cut -d. -f1,2)
  if py_ok "$_py" "$_mm" "$_req" "$_own" "$_cwd"; then log "Python $_mm environment at $_py is ready"; echo "@@PY same $_py"; return 0; fi
  act_uv || { log "Could not install uv (Python installer)"; return 1; }
  export UV_PYTHON_INSTALL_DIR=/opt/shift/python UV_CACHE_DIR=/var/cache/shift-uv
  if [ "$_venv" != "-" ]; then _dest=$_venv; else _dest=$_new; fi
  [ -e "$_dest" ] && mv "$_dest" "$_dest.shift-old-$(date +%s)"
  log "Creating Python $_ver environment at $_dest"
  /usr/local/bin/uv python install -q "$_ver" 2>/dev/null || /usr/local/bin/uv python install -q "$_mm" || return 1
  /usr/local/bin/uv venv -q --seed --python "$_ver" "$_dest" 2>/dev/null || /usr/local/bin/uv venv -q --seed --python "$_mm" "$_dest" || return 1
  chmod -R a+rX /opt/shift/python 2>/dev/null
  py_install "$_dest/bin/python" "$_req" "$_opt"
  chown -R "$_own:$(user_group "$_own")" "$_dest"
  echo "@@PY rebuilt $_dest"
}

# ---------------- pm2 ----------------
pm2_do() { # USER HOME PM2BIN NODEBIN args...
  _u=$1 _h=$2 _pb=$3 _nd=$(dirname "$4"); shift 4
  _a=; for _x in "$@"; do _a="$_a $(q "$_x")"; done
  as_user "$_u" "HOME=$(q "$_h") PM2_HOME=$(q "$_h/.pm2") PATH=$(q "$_nd"):\$PATH $(q "$_pb")$_a"
}
act_pm2_stop() { # USER HOME PM2BIN NODEBIN NAME...
  _u=$1 _h=$2 _pb=$3 _nb=$4; shift 4
  backup_file "$_h/.pm2/dump.pm2"
  for _n in "$@"; do pm2_do "$_u" "$_h" "$_pb" "$_nb" stop "$_n" >/dev/null 2>&1; pm2_do "$_u" "$_h" "$_pb" "$_nb" delete "$_n" >/dev/null 2>&1; done
  pm2_do "$_u" "$_h" "$_pb" "$_nb" save --force >/dev/null 2>&1
  _j=$(pm2_do "$_u" "$_h" "$_pb" "$_nb" jlist 2>/dev/null)
  for _n in "$@"; do echo "$_j" | grep -qF "\"name\":\"$_n\"" && { log "PM2 app $_n is still running"; return 1; }; done
  return 0
}
act_pm2_load() { # USER HOME PM2BIN NODEBIN DUMPFILE  — start the apps in DUMPFILE (keeps others running)
  _u=$1 _h=$2 _pb=$3 _nb=$4 _f=$5
  mkdir -p "$_h/.pm2"; chown "$_u:$(user_group "$_u")" "$_h/.pm2"
  [ -f "$_h/.pm2/dump.pm2" ] && cp -a "$_h/.pm2/dump.pm2" "$W/pm2-keep-$_u"
  cp "$_f" "$_h/.pm2/dump.pm2"; chown "$_u:$(user_group "$_u")" "$_h/.pm2/dump.pm2"
  pm2_do "$_u" "$_h" "$_pb" "$_nb" resurrect || return 1
  sleep 2
  pm2_do "$_u" "$_h" "$_pb" "$_nb" save --force >/dev/null 2>&1
  return 0
}
act_pm2_boot() { # USER HOME PM2BIN NODEBIN
  _u=$1 _h=$2 _pb=$3 _nd=$(dirname "$4")
  if has_systemd; then
    env PATH="$_nd:$PATH" "$_pb" startup systemd -u "$_u" --hp "$_h" >/dev/null 2>&1; svc enable "pm2-$_u"; return 0
  elif have rc-service; then
    env PATH="$_nd:$PATH" "$_pb" startup openrc -u "$_u" --hp "$_h" >/dev/null 2>&1 && return 0
  fi
  act_cron_service
  cron_add "$_u" "@reboot HOME=$_h PM2_HOME=$_h/.pm2 PATH=$_nd:/usr/local/bin:/usr/bin:/bin $_pb resurrect >/dev/null 2>&1 # shift-pm2"
}
act_pm2_rollback() { # USER HOME PM2BIN NODEBIN DUMPFILE — restart only apps that are not running now
  _u=$1 _h=$2 _pb=$3 _nb=$4 _f=$5
  [ -f "$_f" ] || return 0
  pm2_do "$_u" "$_h" "$_pb" "$_nb" jlist > "$W/pm2-cur-$_u.json" 2>/dev/null
  "$_nb" -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));let c=[];try{const t=fs.readFileSync(process.argv[2],"utf8");c=JSON.parse(t.slice(t.indexOf("[")))}catch(e){}const have=new Set(c.map(x=>x.name));fs.writeFileSync(process.argv[3],JSON.stringify(d.filter(x=>!have.has(x.name))))' \
    "$_f" "$W/pm2-cur-$_u.json" "$W/pm2-rb-$_u.json" || return 1
  if [ "$(cat "$W/pm2-rb-$_u.json")" != "[]" ]; then act_pm2_load "$_u" "$_h" "$_pb" "$_nb" "$W/pm2-rb-$_u.json" || return 1; fi
  restore_file "$_h/.pm2/dump.pm2"; chown "$_u" "$_h/.pm2/dump.pm2" 2>/dev/null
  return 0
}
act_pm2_remove() { # USER HOME PM2BIN NODEBIN NAME...  (rollback on the new server)
  _u=$1 _h=$2 _pb=$3 _nb=$4; shift 4
  for _n in "$@"; do pm2_do "$_u" "$_h" "$_pb" "$_nb" delete "$_n" >/dev/null 2>&1; done
  pm2_do "$_u" "$_h" "$_pb" "$_nb" save --force >/dev/null 2>&1; return 0
}
act_relaunch() { # USER MODE SESSION SCRIPT LOG PIDNAME CMDLINE ALTCMDLINE — relaunch unless already running
  for _pp in /proc/[0-9]*; do
    _cl=$(tr '\000' ' ' < "$_pp/cmdline" 2>/dev/null | sed 's/ *$//')
    [ -n "$_cl" ] || continue
    if [ "$_cl" = "$7" ] || [ "$_cl" = "$8" ]; then log "$3 is already running"; return 0; fi
  done
  act_launch "$1" "$2" "$3" "$4" "$5" "$6"
}
act_launch_stop() { # NAME
  _p=$(cat "/var/lib/shift/pids/$1.pid" 2>/dev/null); [ -n "$_p" ] && stop_pid "$_p"; return 0
}
confirm_stopped() { # checks are passed as "kind:value" words
  _bad=
  for _c in "$@"; do
    _k=${_c%%:*}; _v=${_c#*:}
    case $_k in
      pid) if pid_alive "$_v"; then stop_pid "$_v" || _bad="$_bad pid:$_v"; fi ;;
      unit) svc is-active "$_v" && { svc stop "$_v"; sleep 2; svc is-active "$_v" && _bad="$_bad $_v"; } ;;
      docker) [ "$(docker inspect -f '{{.State.Running}}' "$_v" 2>/dev/null)" = true ] && { docker stop -t 20 "$_v" >/dev/null 2>&1; [ "$(docker inspect -f '{{.State.Running}}' "$_v" 2>/dev/null)" = true ] && _bad="$_bad container:$_v"; } ;;
      sup) supervisorctl status "$_v" 2>/dev/null | grep -q RUNNING && { supervisorctl stop "$_v" >/dev/null 2>&1; supervisorctl status "$_v" 2>/dev/null | grep -q RUNNING && _bad="$_bad $_v"; } ;;
    esac
  done
  if [ -n "$_bad" ]; then log "Still running:$_bad"; return 1; fi
  return 0
}

# ---------------- cron ----------------
cron_add() { # USER LINE
  have crontab || return 1
  _t=$(mktemp); crontab -u "$1" -l 2>/dev/null > "$_t"
  grep -qxF "$2" "$_t" || printf '%s\n' "$2" >> "$_t"
  crontab -u "$1" "$_t"; _rc=$?; rm -f "$_t"; return $_rc
}
act_cron_backup() { # USER  (remember the crontab before Shift touches it)
  have crontab || return 0
  [ -f "$BK/cron-$1" ] || { crontab -u "$1" -l > "$BK/cron-$1" 2>/dev/null || : > "$BK/cron-$1"; }
  return 0
}
act_cron_install() { # USER FILE  (merge lines)
  act_cron_service
  act_cron_backup "$1"
  _t=$(mktemp); crontab -u "$1" -l 2>/dev/null > "$_t"
  while IFS= read -r _l; do [ -n "$_l" ] || continue; grep -qxF "$_l" "$_t" || printf '%s\n' "$_l" >> "$_t"; done < "$2"
  crontab -u "$1" "$_t"; _rc=$?; rm -f "$_t"; return $_rc
}
act_cron_disable() { # USER
  have crontab || return 1
  [ -f "$BK/cron-$1" ] || crontab -u "$1" -l > "$BK/cron-$1" 2>/dev/null
  sed 's/^\([[:space:]]*[^#[:space:]]\)/#SHIFT-OFF# \1/' "$BK/cron-$1" > "$W/cron-off-$1"
  crontab -u "$1" "$W/cron-off-$1"
}
act_cron_restore() { # USER
  [ -f "$BK/cron-$1" ] || return 0
  if [ -s "$BK/cron-$1" ]; then crontab -u "$1" "$BK/cron-$1"; else crontab -u "$1" -r 2>/dev/null; fi; return 0
}
act_file_park() { # PATH  — move a config out of the way (kept in backup)
  [ -e "$1" ] || [ -L "$1" ] || return 0
  backup_file "$1"; rm -f "$1"
}
act_file_unpark() { restore_file "$1"; }

# ---------------- systemd units / launchers ----------------
act_unit_stop() { # UNIT
  svc stop "$1"; svc disable "$1"; return 0
}
act_unit_restore() { # UNIT WASENABLED WASACTIVE
  [ "$2" = 1 ] && svc enable "$1"
  [ "$3" = 1 ] && svc start "$1"
  return 0
}
act_unit_start() { # UNIT ENABLE
  has_systemd && systemctl daemon-reload
  [ "$2" = 1 ] && svc enable "$1"
  svc restart "$1"
}
act_launch() { # USER MODE(screen|tmux|nohup) SESSION SCRIPT LOG PIDNAME
  _u=$1 _m=$2 _n=$3 _s=$4 _l=$5 _pn=${6:-$3}
  chmod 755 "$_s"; mkdir -p "$(dirname "$_l")"; touch "$_l"; chown "$_u" "$_l" 2>/dev/null
  mkdir -p /var/lib/shift/pids; : > "/var/lib/shift/pids/$_pn.pid"; chown "$_u" "/var/lib/shift/pids/$_pn.pid"; chmod 755 /var/lib/shift /var/lib/shift/pids
  if [ "$_m" = screen ] && ! have screen; then pkg_install screen >/dev/null 2>&1 || _m=nohup; fi
  if [ "$_m" = tmux ] && ! have tmux; then pkg_install tmux >/dev/null 2>&1 || _m=nohup; fi
  case $_m in
    screen) as_user "$_u" "cd / && screen -dmS $(q "$_n") /bin/sh -c $(q "/bin/sh $_s >> $_l 2>&1")" ;;
    tmux) as_user "$_u" "cd / && tmux new-session -d -s $(q "$_n") $(q "/bin/sh $_s >> $_l 2>&1")" ;;
    *) _ss=; have setsid && _ss=setsid
       as_user "$_u" "cd / && $_ss nohup /bin/sh $(q "$_s") >> $(q "$_l") 2>&1 < /dev/null &" ;;
  esac
  _i=0; while [ $_i -lt 20 ]; do _p=$(cat "/var/lib/shift/pids/$_pn.pid" 2>/dev/null); pid_alive "$_p" && break; sleep 0.5 2>/dev/null || sleep 1; _i=$((_i+1)); done
  sleep 2
  pid_alive "$(cat "/var/lib/shift/pids/$_pn.pid" 2>/dev/null)" || { log "It exited right after starting. Last output:"; tail -n 15 "$_l" >&2; return 1; }
}
act_launch_boot() { # USER MODE NAME SCRIPT LOG  — start at reboot when there is no systemd
  act_cron_service
  case $2 in
    screen) cron_add "$1" "@reboot screen -dmS $3 /bin/sh -c '/bin/sh $4 >> $5 2>&1' # shift-launch" ;;
    *) cron_add "$1" "@reboot /bin/sh $4 >> $5 2>&1 # shift-launch" ;;
  esac
}
act_proc_stop() { # PID...
  for _p in "$@"; do stop_pid "$_p" || { log "Process $_p did not stop"; return 1; }; done; return 0
}
act_pidfile_alive() { pid_alive "$(cat "/var/lib/shift/pids/$1.pid" 2>/dev/null)"; }
act_kill_strays() { # DIR...  — stop leftover app processes still running from inside moved folders
  for _d in "$@"; do
    for _pp in /proc/[0-9]*; do
      _p=${_pp#/proc/}; [ "$_p" = "$$" ] && continue
      _c=$(readlink "$_pp/cwd" 2>/dev/null) || continue
      case "$_c/" in "$_d"/*) ;; *) continue ;; esac
      case "$(readlink "$_pp/exe" 2>/dev/null)" in
        */node|*/nodejs|*/bun|*/deno|*/python*|*/php*|*/java|*/ruby*|*/dotnet|"$_d"/*)
          log "Stopping leftover process $_p ($(tr '\000' ' ' < "$_pp/cmdline" | cut -c1-120))"; stop_pid "$_p" ;;
      esac
    done
  done
  return 0
}

# ---------------- docker ----------------
have_compose() { docker compose version >/dev/null 2>&1; }
act_docker() {
  if have docker && docker info >/dev/null 2>&1; then :
  else
    case $OS_ID in
      ubuntu|debian|raspbian|centos|rhel|fedora) dl https://get.docker.com /tmp/get-docker.sh && sh /tmp/get-docker.sh >/dev/null ;;
      rocky|almalinux|ol) pkg_install dnf-plugins-core && dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo && \
        pkg_install docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin ;;
      amzn) pkg_install docker ;;
      alpine) pkg_install docker docker-cli-compose ;;
      arch|manjaro) pkg_install docker docker-compose ;;
      *) dl https://get.docker.com /tmp/get-docker.sh && sh /tmp/get-docker.sh >/dev/null || pkg_install docker.io || pkg_install docker ;;
    esac
    svc enable docker; svc start docker
    _i=0; while ! docker info >/dev/null 2>&1 && [ $_i -lt 60 ]; do sleep 1; _i=$((_i+1)); done
  fi
  docker info >/dev/null 2>&1 || return 1
  if ! have_compose; then
    mkdir -p /usr/local/lib/docker/cli-plugins
    dl "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" /usr/local/lib/docker/cli-plugins/docker-compose && \
      chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  fi
  have_compose
}
act_dvol() { # NAME LABEL=VALUE...
  _n=$1; shift
  if ! docker volume inspect "$_n" >/dev/null 2>&1; then
    _a=; for _l in "$@"; do _a="$_a --label $(q "$_l")"; done
    eval "docker volume create $_a $(q "$_n")" >/dev/null || return 1
  fi
  out VOL "$_n" "$(docker volume inspect -f '{{.Mountpoint}}' "$_n")"
}
act_docker_stop() { # ID
  docker stop -t 20 "$1" >/dev/null && docker update --restart=no "$1" >/dev/null
}
act_docker_restore() { # ID POLICY
  docker update --restart="$2" "$1" >/dev/null 2>&1; docker start "$1" >/dev/null
}

# ---------------- supervisor ----------------
act_supervisor() {
  have supervisorctl || { act_epel; case $OS_FAMILY in debian|alpine|arch) pkg_install supervisor ;; *) pkg_install supervisor || pkg_install python3-supervisor ;; esac; } || return 1
  _s=$(svc_first supervisor supervisord) && { svc enable "$_s"; svc is-active "$_s" || svc start "$_s"; }
  [ -S /var/run/supervisor.sock ] || [ -S /run/supervisor.sock ] || [ -S /var/run/supervisor/supervisor.sock ] || sleep 2
  return 0
}
act_sup_disable() { # CONF PROG...
  _c=$1; shift
  for _p in "$@"; do supervisorctl stop "$_p" >/dev/null 2>&1; done
  act_file_park "$_c"; supervisorctl reread >/dev/null 2>&1; supervisorctl update >/dev/null 2>&1; return 0
}
act_sup_restore() { restore_file "$1"; supervisorctl reread >/dev/null 2>&1; supervisorctl update >/dev/null 2>&1; return 0; }
act_sup_apply() { supervisorctl reread && supervisorctl update; }

# ---------------- web servers ----------------
ngx_reload() { nginx -t 2>&1 || return 1; if proc_running nginx; then nginx -s reload 2>/dev/null || svc reload nginx; else svc start nginx; fi; }
act_ngx_disable() { # ENABLED_PATH
  act_file_park "$1"
  ngx_reload >/dev/null 2>&1 || { log "nginx config test failed after disabling $1, restoring it"; restore_file "$1"; ngx_reload; return 1; }
}
act_ngx_restore() { restore_file "$1"; ngx_reload; }
act_nginx() {
  have nginx || { act_epel; pkg_install nginx; } || return 1
  svc enable nginx; return 0
}
act_ngx_place() { # NAME SRCFILE
  if [ -d /etc/nginx/sites-enabled ]; then
    mkdir -p /etc/nginx/sites-available; cp "$2" "/etc/nginx/sites-available/$1"; ln -sf "/etc/nginx/sites-available/$1" "/etc/nginx/sites-enabled/$1"
  else mkdir -p /etc/nginx/conf.d; cp "$2" "/etc/nginx/conf.d/$1.conf"; fi
}
act_ngx_apply() {
  if ! _e=$(nginx -t 2>&1); then
    if echo "$_e" | grep -q 'duplicate default server'; then
      log "Disabling the new server's default nginx site (it conflicts with your site)"
      [ -e /etc/nginx/sites-enabled/default ] && act_file_park /etc/nginx/sites-enabled/default
      nginx -t 2>/dev/null || { for _f in /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do [ -f "$_f" ] && sed -i 's/[[:space:]]default_server//' "$_f"; done; }
    fi
    nginx -t || return 1
  fi
  svc enable nginx; if proc_running nginx; then nginx -s reload || svc restart nginx; else svc start nginx || nginx; fi
  sleep 1; proc_running nginx
}
act_apache() {
  if [ "$OS_FAMILY" = debian ]; then have apache2ctl || pkg_install apache2 || return 1; else have httpd || pkg_install httpd || return 1; fi
  return 0
}
act_apache_place() { # NAME SRCFILE MODS
  if [ -d /etc/apache2/sites-available ]; then
    cp "$2" "/etc/apache2/sites-available/$1.conf"; a2ensite "$1" >/dev/null 2>&1
    for _m in $3; do a2enmod "${_m%_module}" >/dev/null 2>&1; done
  else cp "$2" "/etc/httpd/conf.d/$1.conf"; fi
}
act_apache_apply() {
  _s=$(svc_first apache2 httpd) || return 1
  if have apache2ctl; then apache2ctl configtest || return 1; else apachectl configtest || return 1; fi
  svc enable "$_s"; svc restart "$_s"
}
act_apache_disable() { act_file_park "$1"; _s=$(svc_first apache2 httpd) && svc reload "$_s"; return 0; }
act_apache_restore() { restore_file "$1"; _s=$(svc_first apache2 httpd) && svc reload "$_s"; return 0; }
act_caddy() {
  have caddy && return 0
  _a=$(uname -m); case $_a in x86_64) _a=amd64 ;; aarch64) _a=arm64 ;; armv7l) _a=armv7 ;; esac
  dl "https://caddyserver.com/api/download?os=linux&arch=$_a" /usr/bin/caddy && chmod 755 /usr/bin/caddy || return 1
  group_exists caddy || act_group caddy ""
  user_exists caddy || act_user caddy "" caddy /var/lib/caddy /usr/sbin/nologin ""
  mkdir -p /var/lib/caddy /etc/caddy; chown -R caddy:caddy /var/lib/caddy
  if has_systemd; then cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload; fi
}
act_caddy_apply() {
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile; return 1; }
  chown -R caddy:caddy /var/lib/caddy 2>/dev/null
  if svc exists caddy; then svc enable caddy; svc restart caddy
  else setsid nohup caddy run --config /etc/caddy/Caddyfile >/var/log/caddy.log 2>&1 < /dev/null & fi
}
act_svc_park() { # SERVICE  (stop + disable, remember)
  svc is-active "$1" && echo 1 > "$BK/svc-active-$1"; svc is-enabled "$1" && echo 1 > "$BK/svc-enabled-$1"
  svc stop "$1"; svc disable "$1"; return 0
}
act_svc_unpark() { [ -f "$BK/svc-enabled-$1" ] && svc enable "$1"; [ -f "$BK/svc-active-$1" ] && svc start "$1"; return 0; }
act_php() { # VERSION PKG_SUFFIXES...
  _v=$1; shift
  case $OS_FAMILY in
    debian)
      pkg_update
      if ! apt-cache show "php$_v-fpm" >/dev/null 2>&1; then
        log "Adding PHP $_v repository"
        if [ "$OS_ID" = ubuntu ]; then pkg_install software-properties-common gnupg && add-apt-repository -y ppa:ondrej/php >/dev/null
        else pkg_install ca-certificates curl gnupg && dl https://packages.sury.org/php/apt.gpg /usr/share/keyrings/sury-php.gpg && \
          echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ $OS_CODENAME main" > /etc/apt/sources.list.d/sury-php.list; fi
        PM_UPDATED=; pkg_update
      fi
      pkg_install "php$_v-fpm" "php$_v-cli" || return 1
      for _m in "$@"; do pkg_try "php$_v-$_m"; done
      svc enable "php$_v-fpm"; svc restart "php$_v-fpm" ;;
    rhel)
      pkg_install php-fpm php-cli || return 1; for _m in "$@"; do pkg_try "php-$_m"; done
      svc enable php-fpm; svc restart php-fpm ;;
    alpine)
      _n=$(echo "$_v" | tr -d .); pkg_install "php$_n" "php$_n-fpm" || pkg_install php php-fpm || return 1
      for _m in "$@"; do pkg_try "php$_n-$_m"; done; _s=$(svc_first "php-fpm$_n" php-fpm) && { svc enable "$_s"; svc restart "$_s"; } ;;
    *) pkg_install php php-fpm || return 1 ;;
  esac
  return 0
}
act_certbot() {
  have certbot && return 0
  act_epel
  case $OS_FAMILY in debian|rhel) pkg_install certbot python3-certbot-nginx || pkg_install certbot ;; alpine) pkg_install certbot certbot-nginx ;; arch) pkg_install certbot certbot-nginx ;; *) pkg_install certbot ;; esac
  return 0
}
act_selinux() { # PATH...
  have getenforce && [ "$(getenforce 2>/dev/null)" = Enforcing ] || return 0
  have restorecon && restorecon -R "$@" 2>/dev/null
  have setsebool && setsebool -P httpd_can_network_connect 1 2>/dev/null
  return 0
}
act_fw_open() { # PORT
  _p=$1
  if have ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow "$_p/tcp" >/dev/null; return 0; fi
  if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then firewall-cmd -q --permanent --add-port="$_p/tcp"; firewall-cmd -q --reload; return 0; fi
  if have iptables && iptables -S INPUT 2>/dev/null | grep -qE -- '-j (REJECT|DROP)|^-P INPUT DROP'; then
    iptables -C INPUT -p tcp --dport "$_p" -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport "$_p" -j ACCEPT
    if have netfilter-persistent; then netfilter-persistent save >/dev/null 2>&1
    elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4
    elif [ -f /etc/sysconfig/iptables ]; then iptables-save > /etc/sysconfig/iptables; fi
  fi
  return 0
}

# ---------------- databases ----------------
MYA() { if [ -f "$W/mysql.cnf" ]; then echo "--defaults-extra-file=$W/mysql.cnf"; elif [ -f /etc/mysql/debian.cnf ] && ! mysql -e 'select 1' >/dev/null 2>&1; then echo "--defaults-file=/etc/mysql/debian.cnf"; fi; }
act_mysql_server() { # FLAVOR
  if ! { proc_running mysqld || proc_running mariadbd; }; then
    if ! have mysqld && ! have mariadbd && ! [ -x /usr/sbin/mysqld ] && ! [ -x /usr/sbin/mariadbd ]; then
      case $OS_FAMILY in
        debian) if [ "$1" = mysql ] && apt-cache show mysql-server >/dev/null 2>&1; then pkg_install mysql-server; else pkg_install mariadb-server mariadb-client; fi ;;
        rhel) if [ "$1" = mysql ]; then pkg_install mysql-server || pkg_install mariadb-server; else pkg_install mariadb-server || pkg_install mariadb105-server; fi ;;
        alpine) pkg_install mariadb mariadb-client && { [ -d /var/lib/mysql/mysql ] || mysql_install_db --user=mysql --datadir=/var/lib/mysql >/dev/null; } ;;
        arch) pkg_install mariadb && { [ -d /var/lib/mysql/mysql ] || mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql >/dev/null; } ;;
        *) pkg_install mariadb-server ;;
      esac || return 1
    fi
    _s=$(svc_first mariadb mysql mysqld) || return 1
    svc enable "$_s"; svc start "$_s" || svc restart "$_s"
  fi
  _i=0; until mysql $(MYA) -e 'select 1' >/dev/null 2>&1 || [ $_i -ge 90 ]; do sleep 1; _i=$((_i+1)); done
  mysql $(MYA) -e 'select 1' >/dev/null
}
act_mysql_count() { # "DB DB..."
  _a=$(MYA)
  for _db in $1; do
    _qq=$(mysql $_a -N -B -r -e "SET SESSION group_concat_max_len=10000000; SELECT GROUP_CONCAT(CONCAT('SELECT ', QUOTE(CONCAT(table_schema,'.',table_name)), ', COUNT(*) FROM \`', table_schema, '\`.\`', table_name, '\`') SEPARATOR ' UNION ALL ') FROM information_schema.tables WHERE table_schema='$_db' AND table_type='BASE TABLE'" 2>/dev/null)
    [ -n "$_qq" ] && [ "$_qq" != NULL ] && mysql $_a -N -B -e "$_qq" 2>/dev/null
  done | awk -F'\t' '{print "mysql|"$1"|"$2}'
}
act_mysql_dump() { # "DB DB..."
  mkdir -p "$W/db"; chmod 700 "$W/db"; _a=$(MYA)
  mysqldump $_a --single-transaction --quick --routines --triggers --events --hex-blob --databases $1 > "$W/db/mysql.sql" || return 1
  mysql $_a -N -B -e "SELECT CONCAT(QUOTE(user),'@',QUOTE(host)) FROM mysql.user WHERE user NOT IN ('root','mysql.sys','mysql.session','mysql.infoschema','debian-sys-maint','mariadb.sys','healthchecker','')" > "$W/db/mysql-userlist" 2>/dev/null
  : > "$W/db/mysql-users.sql"
  while IFS= read -r _uh; do
    _c=$(mysql $_a -N -B -r -e "SET SESSION print_identified_with_as_hex=ON; SHOW CREATE USER $_uh" 2>/dev/null || mysql $_a -N -B -r -e "SHOW CREATE USER $_uh" 2>/dev/null)
    [ -n "$_c" ] && printf '%s;\n' "$_c" | sed 's/^CREATE USER /CREATE USER IF NOT EXISTS /' >> "$W/db/mysql-users.sql"
    mysql $_a -N -B -r -e "SHOW GRANTS FOR $_uh" 2>/dev/null | sed 's/$/;/' >> "$W/db/mysql-users.sql"
  done < "$W/db/mysql-userlist"
  echo "FLUSH PRIVILEGES;" >> "$W/db/mysql-users.sql"
  act_mysql_count "$1" > "$W/db/mysql.counts"
}
act_mysql_restore() {
  _a=$(MYA)
  mysql $_a < "$W/db/mysql.sql" || return 1
  mysql $_a --force < "$W/db/mysql-users.sql" 2> "$W/db/mysql-users.err" || \
    echo "@@WARN $(printf 'Some MySQL users could not be recreated: %s' "$(head -c 300 "$W/db/mysql-users.err")" | base64 | tr -d '\n')"
  return 0
}
PGU() { su -s /bin/sh postgres -c "$*"; }
act_pg_server() { # MAJOR
  if ! proc_running postgres; then
    if ! have psql || ! PGU "psql -At -c 'select 1'" >/dev/null 2>&1; then
      case $OS_FAMILY in
        debian)
          pkg_update
          if ! apt-cache show "postgresql-$1" >/dev/null 2>&1; then
            log "Adding the official PostgreSQL repository"
            pkg_install ca-certificates curl gnupg >/dev/null 2>&1; mkdir -p /usr/share/postgresql-common/pgdg
            dl https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
            echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $OS_CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list
            PM_UPDATED=; pkg_update
          fi
          pkg_install "postgresql-$1" || pkg_install postgresql || return 1 ;;
        rhel)
          dnf -qy module enable "postgresql:$1" >/dev/null 2>&1
          pkg_install postgresql-server postgresql-contrib || pkg_install "postgresql$1-server" || pkg_install postgresql16-server || pkg_install postgresql15-server || return 1
          for _d in /var/lib/pgsql/data /var/lib/pgsql/$1/data; do :; done
          [ -f /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb >/dev/null 2>&1 || postgresql-setup initdb >/dev/null 2>&1 ;;
        alpine) pkg_install postgresql postgresql-contrib && { ls /var/lib/postgresql/*/data/PG_VERSION >/dev/null 2>&1 || rc-service postgresql setup; } ;;
        arch) pkg_install postgresql && { [ -f /var/lib/postgres/data/PG_VERSION ] || PGU "initdb -D /var/lib/postgres/data" >/dev/null; } ;;
        *) pkg_install postgresql-server || pkg_install postgresql ;;
      esac || return 1
    fi
    _s=$(svc_first postgresql "postgresql-$1") || return 1
    svc enable "$_s"; svc start "$_s" || svc restart "$_s"
  fi
  _i=0; until PGU "psql -At -c 'select 1'" >/dev/null 2>&1 || [ $_i -ge 90 ]; do sleep 1; _i=$((_i+1)); done
  PGU "psql -At -c 'select 1'" >/dev/null
}
act_pg_count() {
  for _db in $(PGU "psql -At -c \"SELECT datname FROM pg_database WHERE NOT datistemplate AND datname<>'postgres'\""); do
    _qq=$(PGU "psql -At -d '$_db' -c \"SELECT string_agg(format('SELECT %L, count(*) FROM %I.%I', '$_db.'||schemaname||'.'||relname, schemaname, relname), ' UNION ALL ') FROM pg_stat_user_tables\"")
    [ -n "$_qq" ] && printf '%s;\n' "$_qq" | PGU "psql -At -F '|' -d '$_db'"
  done | awk -F'|' 'NF==2{print "postgres|"$1"|"$2}'
}
act_pg_dump() {
  mkdir -p "$W/db"; chmod 700 "$W/db"
  PGU "pg_dumpall" > "$W/db/pg.sql" || return 1
  act_pg_count > "$W/db/pg.counts"
}
act_pg_restore() {
  PGU "psql -X -q -d postgres" < "$W/db/pg.sql" > /dev/null 2> "$W/db/pg.err"
  _e=$(grep 'ERROR' "$W/db/pg.err" | grep -v 'already exists' | head -n 5)
  [ -n "$_e" ] && echo "@@WARN $(printf 'PostgreSQL restore messages: %s' "$_e" | base64 | tr -d '\n')"
  return 0
}
redis_cli() { have redis-cli && echo redis-cli || echo valkey-cli; }
redis_auth() { if [ -n "$1" ]; then export REDISCLI_AUTH="$1"; else unset REDISCLI_AUTH; fi; }
redis_conf() { for _c in /etc/redis/redis.conf /etc/redis.conf /etc/redis/6379.conf /etc/redis6/redis6.conf /etc/valkey/valkey.conf; do [ -f "$_c" ] && { echo "$_c"; return; }; done; }
act_redis_server() {
  if ! { proc_running redis-server || proc_running valkey-server; }; then
    if ! have redis-server && ! have valkey-server; then
      case $OS_FAMILY in debian) pkg_install redis-server ;; rhel) act_epel; pkg_install redis || pkg_install redis6 || pkg_install valkey ;; *) pkg_install redis || pkg_install valkey ;; esac || return 1
    fi
    _s=$(svc_first redis-server redis redis6 valkey) || return 1
    svc enable "$_s"; svc start "$_s" || svc restart "$_s"
  fi
  sleep 1; proc_running redis-server || proc_running valkey-server
}
act_redis_dump() {
  mkdir -p "$W/db"; chmod 700 "$W/db"
  _c=$(redis_conf); _pw=; [ -n "$_c" ] && _pw=$(awk '$1=="requirepass"{print $2}' "$_c" | tr -d '"')
  _cli=$(redis_cli)
  redis_auth "$_pw"; $_cli SAVE >/dev/null || return 1
  _d=$(redis_auth "$_pw"; $_cli CONFIG GET dir 2>/dev/null | sed -n 2p | tr -d '\r'); _f=$(redis_auth "$_pw"; $_cli CONFIG GET dbfilename 2>/dev/null | sed -n 2p | tr -d '\r')
  cp "${_d:-/var/lib/redis}/${_f:-dump.rdb}" "$W/db/redis.rdb" || return 1
  printf '%s' "$_pw" > "$W/db/redis.pass"
  redis_auth "$_pw"; $_cli INFO keyspace | tr -d '\r' | awk -F'[:=,]' '/^db/{print "redis|"$1"|"$3}' > "$W/db/redis.counts"
}
act_redis_restore() {
  _cli=$(redis_cli); _c=$(redis_conf); _pw=$(cat "$W/db/redis.pass" 2>/dev/null)
  _d=$($_cli CONFIG GET dir 2>/dev/null | sed -n 2p | tr -d '\r'); _f=$($_cli CONFIG GET dbfilename 2>/dev/null | sed -n 2p | tr -d '\r')
  _d=${_d:-/var/lib/redis}; _f=${_f:-dump.rdb}
  _s=$(svc_first redis-server redis redis6 valkey) || return 1
  svc stop "$_s"; sleep 1
  cp "$W/db/redis.rdb" "$_d/$_f"; chown redis:redis "$_d/$_f" 2>/dev/null
  if [ -n "$_pw" ] && [ -n "$_c" ]; then
    backup_file "$_c"
    awk -v p="$_pw" '$1=="requirepass"{print "requirepass " p; f=1; next} {print} END{if(!f) print "requirepass " p}' "$_c" > "$_c.shift" && cat "$_c.shift" > "$_c" && rm -f "$_c.shift"
  fi
  svc start "$_s"; sleep 2
}
act_redis_count() { _pw=$(cat "$W/db/redis.pass" 2>/dev/null); redis_auth "$_pw"; $(redis_cli) INFO keyspace | tr -d '\r' | awk -F'[:=,]' '/^db/{print "redis|"$1"|"$3}'; }
act_mongo_server() { # MAJOR(e.g. 7.0)
  proc_running mongod && return 0
  if ! have mongod; then
    case $OS_FAMILY in
      debian)
        pkg_install ca-certificates curl gnupg >/dev/null 2>&1
        dl "https://www.mongodb.org/static/pgp/server-$1.asc" "/usr/share/keyrings/mongodb-$1.asc" || return 1
        if [ "$OS_ID" = ubuntu ]; then echo "deb [signed-by=/usr/share/keyrings/mongodb-$1.asc] https://repo.mongodb.org/apt/ubuntu $OS_CODENAME/mongodb-org/$1 multiverse"
        else echo "deb [signed-by=/usr/share/keyrings/mongodb-$1.asc] https://repo.mongodb.org/apt/debian $OS_CODENAME/mongodb-org/$1 main"; fi > "/etc/apt/sources.list.d/mongodb-org-$1.list"
        PM_UPDATED=; pkg_update; pkg_install mongodb-org || return 1 ;;
      rhel)
        if [ "$OS_ID" = amzn ]; then _r="https://repo.mongodb.org/yum/amazon/2023/mongodb-org/$1/\$basearch/"
        else _r="https://repo.mongodb.org/yum/redhat/\$releasever/mongodb-org/$1/\$basearch/"; fi
        printf '[mongodb-org-%s]\nname=MongoDB\nbaseurl=%s\ngpgcheck=1\nenabled=1\ngpgkey=https://www.mongodb.org/static/pgp/server-%s.asc\n' "$1" "$_r" "$1" > "/etc/yum.repos.d/mongodb-org-$1.repo"
        pkg_install mongodb-org || return 1 ;;
      *) log "Automatic MongoDB install is not supported on $OS_ID"; return 1 ;;
    esac
  fi
  svc enable mongod; svc start mongod
  _i=0; until proc_running mongod || [ $_i -ge 60 ]; do sleep 1; _i=$((_i+1)); done; sleep 3; proc_running mongod
}
mongo_sh() { have mongosh && echo mongosh || echo mongo; }
act_mongo_count() {
  $(mongo_sh) --quiet ${MONGO_URI:+"$MONGO_URI"} --eval 'db.adminCommand({listDatabases:1}).databases.forEach(function(d){ if(["admin","local","config"].indexOf(d.name)>=0) return; var x=db.getSiblingDB(d.name); x.getCollectionNames().forEach(function(c){ print("mongodb|"+d.name+"."+c+"|"+x.getCollection(c).estimatedDocumentCount()); }); })' 2>/dev/null
}
act_mongo_dump() {
  mkdir -p "$W/db"; chmod 700 "$W/db"
  have mongodump || pkg_try mongodb-database-tools
  mongodump ${MONGO_URI:+--uri="$MONGO_URI"} --archive="$W/db/mongo.archive" --gzip --quiet || return 1
  act_mongo_count > "$W/db/mongo.counts"
}
act_mongo_restore() { mongorestore --archive="$W/db/mongo.archive" --gzip --drop --quiet; }
db_procs() { case $1 in mysql) echo "mysqld mariadbd" ;; postgres) echo postgres ;; redis) echo "redis-server valkey-server" ;; mongodb) echo mongod ;; esac; }
db_any_running() { for _x in $(db_procs "$1"); do proc_running "$_x" && return 0; done; return 1; }
act_db_park() { # ENGINE — stop the database server on the old VPS and make sure it is really down
  case $1 in mysql) _s=$(svc_first mariadb mysql mysqld) ;; postgres) _s=$(svc_first postgresql) ;; redis) _s=$(svc_first redis-server redis redis6 valkey) ;; mongodb) _s=$(svc_first mongod) ;; esac
  [ -n "$_s" ] && act_svc_park "$_s"
  sleep 2
  if db_any_running "$1"; then
    log "The $1 server is still running — shutting it down directly"
    echo 1 > "$BK/db-manual-$1"
    case $1 in
      mysql) mysqladmin $(MYA) shutdown 2>/dev/null ;;
      postgres) PGU "pg_ctl -D \"\$(psql -At -c 'show data_directory')\" stop -m fast" 2>/dev/null || { have pg_ctlcluster && pg_ctlcluster --force "$(PGU "psql -At -c 'show server_version_num'" | cut -c1-2)" main stop; } ;;
      redis) redis_auth "$(cat "$W/db/redis.pass" 2>/dev/null)"; $(redis_cli) shutdown 2>/dev/null ;;
      mongodb) $(mongo_sh) --quiet ${MONGO_URI:+"$MONGO_URI"} admin --eval 'db.shutdownServer()' >/dev/null 2>&1 ;;
    esac
    _i=0; while db_any_running "$1" && [ $_i -lt 30 ]; do sleep 1; _i=$((_i+1)); done
  fi
  db_any_running "$1" && { log "Could not stop the $1 server"; return 1; }
  return 0
}
act_db_unpark() {
  case $1 in mysql) _s=$(svc_first mariadb mysql mysqld) ;; postgres) _s=$(svc_first postgresql) ;; redis) _s=$(svc_first redis-server redis redis6 valkey) ;; mongodb) _s=$(svc_first mongod) ;; esac
  [ -n "$_s" ] && act_svc_unpark "$_s"
  if [ -f "$BK/db-manual-$1" ] && ! db_any_running "$1"; then [ -n "$_s" ] && svc start "$_s"; fi
  sleep 1; db_any_running "$1" || { [ -n "$_s" ] && svc start "$_s"; sleep 2; }
  return 0
}

# ---------------- checks ----------------
act_wait_port() { # PORT SECONDS
  _i=0; while [ $_i -lt "$2" ]; do listen_list | grep -q "^@@L [^ ]* $1 " && return 0; sleep 1; _i=$((_i+1)); done; return 1
}
