# Shift remote library — POSIX sh (bash, dash, busybox ash). Prepended to every script.
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 APT_LISTCHANGES_FRONTEND=none
umask 022

have() { command -v "$1" >/dev/null 2>&1; }
log() { printf '%s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
SEP=$(printf '\037')

# out TYPE field... -> "@@TYPE <base64 of fields joined by \037>"
out() {
  _t=$1; shift; _r=""; _first=1
  for _f in "$@"; do if [ -n "$_first" ]; then _r=$_f; _first=; else _r="$_r$SEP$_f"; fi; done
  printf '@@%s %s\n' "$_t" "$(printf '%s' "$_r" | base64 | tr -d '\n')"
}
# outf TYPE label file -> "@@TYPE <b64 label> <b64 file>"
outf() { [ -r "$3" ] || return 0; printf '@@%s %s %s\n' "$1" "$(printf '%s' "$2" | base64 | tr -d '\n')" "$(base64 < "$3" | tr -d '\n')"; }

pw_field() { awk -F: -v u="$1" -v n="$2" '$1==u{print $n; exit}' /etc/passwd; }
pw_home() { pw_field "$1" 6; }
user_exists() { awk -F: -v u="$1" '$1==u{f=1} END{exit !f}' /etc/passwd; }
group_exists() { awk -F: -v g="$1" '$1==g{f=1} END{exit !f}' /etc/group; }
uid_name() { awk -F: -v u="$1" '$3==u{print $1; exit}' /etc/passwd; }
user_group() { _g=$(pw_field "$1" 4); awk -F: -v g="$_g" '$3==g{print $1; exit}' /etc/group; }

os_detect() {
  OS_ID=unknown; OS_LIKE=; OS_VER=; OS_NAME=; OS_CODENAME=
  if [ -r /etc/os-release ]; then
    OS_ID=$(. /etc/os-release; echo "$ID"); OS_LIKE=$(. /etc/os-release; echo "$ID_LIKE")
    OS_VER=$(. /etc/os-release; echo "$VERSION_ID"); OS_NAME=$(. /etc/os-release; echo "$PRETTY_NAME")
    OS_CODENAME=$(. /etc/os-release; echo "$VERSION_CODENAME")
  elif [ -r /etc/redhat-release ]; then OS_ID=centos; OS_LIKE=rhel; OS_NAME=$(cat /etc/redhat-release)
  fi
  case " $OS_ID $OS_LIKE " in
    *" debian "*|*" ubuntu "*) OS_FAMILY=debian ;;
    *" rhel "*|*" fedora "*|*" centos "*|*" amzn "*) OS_FAMILY=rhel ;;
    *" alpine "*) OS_FAMILY=alpine ;;
    *" arch "*) OS_FAMILY=arch ;;
    *" suse "*|*" opensuse "*) OS_FAMILY=suse ;;
    *) OS_FAMILY=other ;;
  esac
}
libc_kind() {
  if ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl; return; fi
  _v=$(ldd --version 2>&1 | head -n1 | grep -o '[0-9]\+\.[0-9]\+$')
  echo "glibc${_v:+-$_v}"
}
has_systemd() { [ -d /run/systemd/system ] && have systemctl; }
init_kind() { if has_systemd; then echo systemd; elif have rc-service; then echo openrc; else echo sysv; fi; }
pm_detect() {
  if have apt-get; then PM=apt; elif have dnf; then PM=dnf; elif have yum; then PM=yum
  elif have apk; then PM=apk; elif have pacman; then PM=pacman; elif have zypper; then PM=zypper; else PM=none; fi
}

dl() { # dl URL FILE
  if have curl; then curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"
  elif have wget; then wget -q -O "$2" "$1"
  else return 1; fi
}

apt_wait() {
  _i=0
  while [ $_i -lt 180 ]; do
    _busy=
    for _p in /proc/[0-9]*; do
      case "$(cat "$_p/comm" 2>/dev/null)" in apt|apt-get|dpkg|unattended-upgr|aptitude) _busy=1; break ;; esac
    done
    [ -z "$_busy" ] && return 0
    [ $_i = 0 ] && log "Waiting for automatic system updates to finish (apt is busy)..."
    _i=$((_i+1)); sleep 5
  done
  return 0
}
PM_UPDATED=
pkg_update() {
  [ -n "$PM_UPDATED" ] && return 0
  case $PM in
    apt) apt_wait; apt-get update -q >/dev/null 2>&1 || { sleep 5; apt_wait; apt-get update -q; } ;;
    apk) apk update -q >/dev/null 2>&1 ;;
    pacman) pacman -Sy --noconfirm >/dev/null 2>&1 ;;
  esac
  PM_UPDATED=1
}
pkg_install() {
  [ $# -gt 0 ] || return 0
  pkg_update
  case $PM in
    apt) apt_wait; apt-get install -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef \
           -o Dpkg::Options::=--force-confold --no-install-recommends "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
    apk) apk add -q "$@" ;;
    pacman) pacman -S --noconfirm --needed "$@" ;;
    zypper) zypper -n -q install "$@" ;;
    *) return 1 ;;
  esac
}
# pkg_try pkg... : install each, ignore failures
pkg_try() { for _p in "$@"; do pkg_install "$_p" >/dev/null 2>&1 || log "  (package $_p not available)"; done; return 0; }
owned_by_pkg() {
  if have dpkg; then dpkg -S "$1" >/dev/null 2>&1 && return 0
    case $1 in /lib/*) dpkg -S "/usr$1" >/dev/null 2>&1 && return 0 ;; /usr/lib/*) dpkg -S "${1#/usr}" >/dev/null 2>&1 && return 0 ;; esac; fi
  if have rpm; then rpm -qf "$1" >/dev/null 2>&1 && return 0; fi
  if have apk; then apk info -W "$1" 2>/dev/null | grep -q 'owned by' && return 0; fi
  if have pacman; then pacman -Qo "$1" >/dev/null 2>&1 && return 0; fi
  return 1
}

# svc ACTION NAME  (start|stop|restart|reload|enable|disable|is-active|is-enabled|exists)
svc() {
  _a=$1; _n=$2
  if has_systemd; then
    case $_a in
      enable|disable) systemctl "$_a" "$_n" >/dev/null 2>&1 ;;
      is-active) systemctl is-active --quiet "$_n" ;;
      is-enabled) systemctl is-enabled --quiet "$_n" 2>/dev/null ;;
      exists) systemctl cat "$_n" >/dev/null 2>&1 ;;
      *) systemctl "$_a" "$_n" ;;
    esac
  elif have rc-service; then
    case $_a in
      enable) rc-update add "$_n" default >/dev/null 2>&1 ;;
      disable) rc-update del "$_n" default >/dev/null 2>&1 ;;
      is-active) rc-service "$_n" status >/dev/null 2>&1 ;;
      is-enabled) rc-update show default 2>/dev/null | grep -q "^ *$_n " ;;
      exists) [ -x "/etc/init.d/$_n" ] ;;
      *) rc-service "$_n" "$_a" ;;
    esac
  else
    case $_a in
      enable) { have update-rc.d && update-rc.d "$_n" defaults; } >/dev/null 2>&1 || { have chkconfig && chkconfig "$_n" on; } >/dev/null 2>&1; return 0 ;;
      disable) { have update-rc.d && update-rc.d "$_n" disable; } >/dev/null 2>&1 || { have chkconfig && chkconfig "$_n" off; } >/dev/null 2>&1; return 0 ;;
      is-active) if have service; then service "$_n" status >/dev/null 2>&1; else "/etc/init.d/$_n" status >/dev/null 2>&1; fi ;;
      is-enabled) ls /etc/rc[2345].d/S*"$_n" >/dev/null 2>&1 ;;
      exists) [ -x "/etc/init.d/$_n" ] ;;
      *) if have service; then service "$_n" "$_a"; elif [ -x "/etc/init.d/$_n" ]; then "/etc/init.d/$_n" "$_a"; else return 1; fi ;;
    esac
  fi
}
svc_first() { for _s in "$@"; do svc exists "$_s" && { echo "$_s"; return 0; }; done; return 1; }

# as_user USER 'command'  (runs through /bin/sh as that user)
as_user() {
  _u=$1; shift
  if [ "$_u" = root ] || [ "$_u" = "$(id -un)" ]; then /bin/sh -c "$*"
  else (cd / && su -s /bin/sh "$_u" -c "cd \"\$HOME\" 2>/dev/null || cd /; $*"); fi
}

proc_running() { for _p in /proc/[0-9]*; do [ "$(cat "$_p/comm" 2>/dev/null)" = "$1" ] && ! grep -q '^State:.*Z' "$_p/status" 2>/dev/null && return 0; done; return 1; }
pid_alive() { [ -n "$1" ] && [ -d "/proc/$1" ] && ! grep -q '^State:.*Z' "/proc/$1/status" 2>/dev/null; }

http_code() { # http_code URL [HOSTHEADER]
  _c=
  if have curl; then
    if [ -n "$2" ]; then _c=$(curl -sk -o /dev/null -m 8 -w '%{http_code}' -H "Host: $2" "$1" 2>/dev/null)
    else _c=$(curl -sk -o /dev/null -m 8 -w '%{http_code}' "$1" 2>/dev/null); fi
  elif have wget; then
    _c=$(wget -S --no-check-certificate -O /dev/null -T 8 -t 1 ${2:+--header="Host: $2"} "$1" 2>&1 | awk '/^  HTTP\//{c=$2} END{print c}')
  fi
  printf '%s' "${_c:-000}"
}
https_code() { # https_code DOMAIN  (talks to 127.0.0.1:443 with correct SNI)
  _c=
  if have curl; then _c=$(curl -sk -o /dev/null -m 8 -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1/" 2>/dev/null); fi
  printf '%s' "${_c:-000}"
}

# listen_list -> "@@L addr port pids(comma)"
listen_list() {
  if have ss; then
    ss -tlnp 2>/dev/null | awk 'NR>1{
      la=$4; n=split(la,a,":"); port=a[n]; addr=substr(la,1,length(la)-length(port)-1);
      pids=""; s=$0;
      while (match(s,/pid=[0-9]+/)) { p=substr(s,RSTART+4,RLENGTH-4); pids=(pids==""?p:pids","p); s=substr(s,RSTART+RLENGTH) }
      print addr" "port" "pids }'
  elif have netstat; then
    netstat -tlnp 2>/dev/null | awk '$1 ~ /^tcp/ {
      la=$4; n=split(la,a,":"); port=a[n]; addr=substr(la,1,length(la)-length(port)-1);
      split($7,b,"/"); print addr" "port" "b[1] }'
  fi | while read -r _a _p _ps; do printf '@@L %s %s %s\n' "$_a" "$_p" "${_ps:--}"; done
}

kill_tree() { # kill_tree PID [SIGNAL]
  _sig=${2:-TERM}
  for _c in $(awk -v p="$1" '$1=="PPid:" && $2==p {print FILENAME}' /proc/[0-9]*/status 2>/dev/null | sed 's|/proc/\([0-9]*\)/status|\1|'); do
    kill_tree "$_c" "$_sig"
  done
  kill "-$_sig" "$1" 2>/dev/null
  return 0
}
stop_pid() { # stop_pid PID : TERM, wait up to 15s, then KILL
  pid_alive "$1" || return 0
  kill_tree "$1" TERM
  _i=0; while pid_alive "$1" && [ $_i -lt 30 ]; do sleep 0.5 2>/dev/null || sleep 1; _i=$((_i+1)); done
  pid_alive "$1" && kill_tree "$1" KILL
  sleep 1; ! pid_alive "$1"
}
