# Shift scanner — READ ONLY. Discovers projects, runtimes, services and databases.
os_detect; pm_detect
out OS "$OS_ID" "$OS_LIKE" "$OS_VER" "$OS_NAME" "$(uname -m)" "$(libc_kind)" "$(init_kind)" "$PM" "$(hostname 2>/dev/null || cat /etc/hostname)" "$OS_FAMILY" "$OS_CODENAME"
outf PASSWD passwd /etc/passwd
outf GROUP group /etc/group
_tz=$(cat /etc/timezone 2>/dev/null); [ -n "$_tz" ] || _tz=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')
out TZ "${_tz:-UTC}"
listen_list

# ---------------- processes ----------------
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  exe=$(readlink "$d/exe" 2>/dev/null) || continue
  [ -n "$exe" ] || continue
  comm=$(cat "$d/comm" 2>/dev/null)
  ppid=; uid=
  while IFS= read -r line; do
    case $line in PPid:*) ppid=${line#PPid:}; ppid=$(echo $ppid) ;; Uid:*) set -- ${line#Uid:}; uid=$1 ;; esac
  done < "$d/status"
  cand=
  case "$exe" in
    */node|*/nodejs|*/bun|*/deno|*/python|*/python[23]*|*/pypy*|*/php|*/php[578]*|*/php-cgi*|*/java|*/ruby*|*/dotnet|*/perl|\
    /home/*|/root/*|/opt/*|/srv/*|/var/www/*|/usr/local/bin/*|/app/*) cand=1 ;;
  esac
  case "$comm" in SCREEN|screen|tmux*|supervisord|PM2*|containerd-shim*|dockerd|sshd|bash|sh|dash|zsh|fish|sudo|su) cand= ;; esac
  out P "$pid" "$ppid" "$uid" "$comm" "$exe" "$cand"
  if [ -n "$cand" ]; then
    cwd=$(readlink "$d/cwd" 2>/dev/null)
    cg=$(tr '\n' ' ' < "$d/cgroup" 2>/dev/null)
    a0=$(tr '\000' '\n' < "$d/cmdline" 2>/dev/null | head -n1)
    r=
    case $a0 in
      /*) r=$a0 ;;
      */*) r="$cwd/$a0" ;;
      ?*) pth=$(tr '\000' '\n' < "$d/environ" 2>/dev/null | sed -n 's/^PATH=//p' | head -n1)
          oIFS=$IFS; IFS=:; for p in ${pth:-/usr/local/bin:/usr/bin:/bin}; do [ -x "$p/$a0" ] && { r="$p/$a0"; break; }; done; IFS=$oIFS
          [ -n "$r" ] || r=$(command -v "$a0" 2>/dev/null) ;;
    esac
    out PX "$pid" "$cwd" "$cg" "$r"
    printf '@@PC %s %s\n' "$pid" "$(base64 < "$d/cmdline" | tr -d '\n')"
    printf '@@PE %s %s\n' "$pid" "$(base64 < "$d/environ" 2>/dev/null | tr -d '\n')"
  fi
  case "$comm" in
    SCREEN|screen|tmux*) printf '@@PC %s %s\n' "$pid" "$(base64 < "$d/cmdline" | tr -d '\n')" ;;
  esac
done

# screen / tmux session names per user
for d in /proc/[0-9]*; do
  case "$(cat "$d/comm" 2>/dev/null)" in
    tmux*) u=$(uid_name "$(awk '/^Uid:/{print $2}' "$d/status")"); echo "$u" ;;
  esac
done 2>/dev/null | sort -u | while read -r u; do
  [ -n "$u" ] || continue
  as_user "$u" "tmux list-panes -a -F '#{pane_pid} #{session_name}'" 2>/dev/null | while read -r pp sn; do out TMUX "$u" "$pp" "$sn"; done
done

# ---------------- PM2 ----------------
for h in $(awk -F: '{print $6}' /etc/passwd | sort -u); do
  [ -d "$h/.pm2" ] || continue
  [ -f "$h/.pm2/pm2.pid" ] || continue
  gp=$(cat "$h/.pm2/pm2.pid" 2>/dev/null); pid_alive "$gp" || { out PM2OFF "$h"; continue; }
  u=$(uid_name "$(awk '/^Uid:/{print $2}' "/proc/$gp/status")")
  nodebin=$(readlink "/proc/$gp/exe")
  pm2bin=
  for c in "$(dirname "$nodebin")/pm2" "$h"/.nvm/versions/node/*/bin/pm2 /usr/local/bin/pm2 /usr/bin/pm2 "$h/.npm-global/bin/pm2" \
           "$h/.local/bin/pm2" "$h/.volta/bin/pm2" "$h/.bun/bin/pm2" "$h"/.local/share/pnpm/pm2; do
    [ -x "$c" ] && { pm2bin=$c; break; }
  done
  if [ -z "$pm2bin" ]; then out PM2ERR "$u" "$h" "pm2 command not found"; continue; fi
  pm2ver=$(as_user "$u" "HOME='$h' PM2_HOME='$h/.pm2' PATH='$(dirname "$nodebin")':\$PATH '$pm2bin' -v" 2>/dev/null | tail -n1)
  j=$(as_user "$u" "HOME='$h' PM2_HOME='$h/.pm2' PATH='$(dirname "$nodebin")':\$PATH '$pm2bin' jlist" 2>/dev/null)
  out PM2 "$u" "$h" "$pm2bin" "$nodebin" "$pm2ver" "$j"
  outf PM2DUMP "$h" "$h/.pm2/dump.pm2"
  svcn="pm2-$u"; en=; svc is-enabled "$svcn" && en=1
  out PM2BOOT "$u" "$svcn" "$en"
done

# ---------------- systemd ----------------
if has_systemd; then
  {
    ls -1 /etc/systemd/system/*.service 2>/dev/null
    systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | while read -r u; do
      systemctl show -p FragmentPath "$u" 2>/dev/null | sed 's/^FragmentPath=//'
    done
  } | sort -u | while read -r f; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    n=${f##*/}
    case $n in
      snap.*|snap-*|pm2-*|cloud-*|dbus*|display-manager*|sshd.service|ssh.service|getty*|*@.service|docker.service|containerd.service|\
      systemd-*|qemu-guest*|google*|amazon-*|oracle-*|walinux*|waagent*|hv-*|vmtoolsd*|open-vm-*|do-agent*|droplet-agent*|aliyun*) continue ;;
    esac
    owned_by_pkg "$f" && continue
    act=$(systemctl is-active "$n" 2>/dev/null); en=$(systemctl is-enabled "$n" 2>/dev/null)
    mp=$(systemctl show -p MainPID "$n" 2>/dev/null | sed 's/^MainPID=//')
    dropins=; [ -d "$f.d" ] && dropins="$f.d"
    out UNIT "$n" "$f" "$act" "$en" "$mp" "$dropins" "$(cat "$f")"
  done
fi

# ---------------- docker ----------------
if have docker && docker info >/dev/null 2>&1; then
  out DOCKERINFO "$(docker info --format '{{.DockerRootDir}}|{{.Architecture}}|{{.ServerVersion}}' 2>/dev/null)"
  ids=$(docker ps -aq 2>/dev/null)
  [ -n "$ids" ] && out DOCKER "$(docker inspect $ids 2>/dev/null)"
  vols=$(docker volume ls -q 2>/dev/null)
  [ -n "$vols" ] && out DVOL "$(docker volume inspect $vols 2>/dev/null)"
  imgs=$(docker ps -a --format '{{.Image}}' 2>/dev/null | sort -u)
  [ -n "$imgs" ] && out DIMG "$(docker image inspect $imgs 2>/dev/null)"
fi

# ---------------- supervisor ----------------
for f in /etc/supervisor/conf.d/*.conf /etc/supervisord.d/*.ini /etc/supervisord.d/*.conf; do
  [ -f "$f" ] && outf SUPCONF "$f" "$f"
done
have supervisorctl && out SUPSTATUS "$(supervisorctl status 2>/dev/null)"

# ---------------- cron ----------------
for f in /var/spool/cron/crontabs/* /var/spool/cron/* /etc/crontabs/*; do
  [ -f "$f" ] || continue
  case ${f##*/} in cron.update|*.lock) continue ;; esac
  grep -v '^[[:space:]]*#' "$f" 2>/dev/null | grep -q '[^[:space:]]' || continue
  outf CRON "${f##*/}" "$f"
done
for f in /etc/cron.d/*; do
  [ -f "$f" ] || continue
  owned_by_pkg "$f" && continue
  case ${f##*/} in .placeholder|*.dpkg-*|*.rpm*|e2scrub_all|popularity-contest|php|sysstat|certbot|anacron|0hourly|raid-check) continue ;; esac
  outf CROND "$f" "$f"
done

# ---------------- web servers ----------------
if [ -d /etc/nginx ]; then
  out NGXVER "$(nginx -v 2>&1 | head -n1)" "$(proc_running nginx && echo running)"
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -e "$f" ] || continue
    r=$(readlink -f "$f" 2>/dev/null || echo "$f")
    case $f in /etc/nginx/conf.d/*) owned_by_pkg "$r" && continue ;; esac
    if [ "${f##*/}" = default ] || owned_by_pkg "$r"; then
      grep -v '^[[:space:]]*#' "$r" | grep -Eq 'proxy_pass|fastcgi_pass|uwsgi_pass|server_name[[:space:]]+[^_;[:space:]]' || continue
    fi
    printf '@@NGX %s %s %s\n' "$(printf '%s' "$f" | base64 | tr -d '\n')" "$(printf '%s' "$r" | base64 | tr -d '\n')" "$(base64 < "$r" | tr -d '\n')"
  done
fi
for f in /etc/apache2/sites-enabled/*.conf /etc/httpd/conf.d/*.conf; do
  [ -e "$f" ] || continue
  r=$(readlink -f "$f" 2>/dev/null || echo "$f")
  case ${f##*/} in 000-default.conf|autoindex.conf|welcome.conf|userdir.conf|ssl.conf|php.conf|README) continue ;; esac
  owned_by_pkg "$r" && continue
  printf '@@APACHE %s %s %s\n' "$(printf '%s' "$f" | base64 | tr -d '\n')" "$(printf '%s' "$r" | base64 | tr -d '\n')" "$(base64 < "$r" | tr -d '\n')"
done
if have apache2ctl; then out APACHEMODS "$(apache2ctl -M 2>/dev/null | awk '/_module/{print $1}' | tr '\n' ' ')"; fi
[ -f /etc/caddy/Caddyfile ] && outf CADDY /etc/caddy/Caddyfile /etc/caddy/Caddyfile
[ -d /etc/letsencrypt/live ] && out LE "$(ls /etc/letsencrypt/live 2>/dev/null | tr '\n' ' ')"
if have php; then
  out PHP "$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null)" "$(php -m 2>/dev/null | grep -v '^\[' | tr '\n' ' ')"
fi
for f in /etc/php/*/fpm/pool.d/*.conf; do [ -f "$f" ] && out PHPFPM "$f"; done

# ---------------- databases ----------------
mysql_args() { if [ -f "$SHIFT_W/mysql.cnf" ]; then echo "--defaults-extra-file=$SHIFT_W/mysql.cnf"; elif [ -f /etc/mysql/debian.cnf ] && ! mysql -e 'select 1' >/dev/null 2>&1; then echo "--defaults-file=/etc/mysql/debian.cnf"; fi; }
if proc_running mysqld || proc_running mariadbd; then
  v=$( (mariadbd --version || mysqld --version) 2>/dev/null | head -n1)
  fl=mysql; echo "$v" | grep -qi mariadb && fl=mariadb
  q="SELECT s.schema_name, COALESCE(SUM(t.data_length+t.index_length),0) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema=s.schema_name WHERE s.schema_name NOT IN ('information_schema','performance_schema','mysql','sys') GROUP BY s.schema_name"
  r=$(mysql $(mysql_args) -N -B -e "$q" 2>&1); rc=$?
  out DB mysql "$fl" "$v" "$rc" "$r"
fi
if proc_running postgres; then
  v=$(su -s /bin/sh postgres -c "psql -At -c 'SHOW server_version'" 2>/dev/null)
  r=$(su -s /bin/sh postgres -c "psql -At -F ' ' -c \"SELECT datname, pg_database_size(datname) FROM pg_database WHERE NOT datistemplate AND datname<>'postgres'\"" 2>&1); rc=$?
  out DB postgres postgres "$v" "$rc" "$r"
fi
if proc_running redis-server || proc_running valkey-server; then
  rp=; for c in /etc/redis/redis.conf /etc/redis.conf /etc/redis/6379.conf /etc/valkey/valkey.conf; do [ -f "$c" ] && { rp=$(awk '$1=="requirepass"{print $2}' "$c" | tr -d '"'); rconf=$c; break; }; done
  cli=redis-cli; have redis-cli || cli=valkey-cli
  [ -n "$rp" ] && export REDISCLI_AUTH="$rp"
  v=$($cli INFO server 2>/dev/null | sed -n 's/^redis_version://p' | tr -d '\r')
  r=$($cli INFO keyspace 2>&1 | tr -d '\r' | grep '^db'); unset REDISCLI_AUTH
  out DB redis redis "$v" "0" "$r" "$rconf"
fi
if proc_running mongod; then
  v=$(mongod --version 2>/dev/null | head -n1)
  sh_=mongosh; have mongosh || sh_=mongo
  r=$($sh_ --quiet --eval 'db.adminCommand({listDatabases:1}).databases.forEach(function(d){print(d.name+" "+d.sizeOnDisk)})' 2>&1); rc=$?
  out DB mongodb mongodb "$v" "$rc" "$r"
fi

# ---------------- folders with projects (not necessarily running) ----------------
for root in /root /home /var/www /opt /srv; do
  [ -d "$root" ] || continue
  find "$root" -maxdepth 4 \( -name node_modules -o -name venv -o -name .venv -o -name __pycache__ -o -name .cache \
      -o -name .npm -o -name .nvm -o -name .pm2 -o -name snap -o -name .local -o -name .cargo -o -name .rustup -o -name go \
      -o -name .vscode-server -o -name .git -o -name vendor -o -name .shift -o -name site-packages \) -prune -o -type f \
      \( -name package.json -o -name requirements.txt -o -name pyproject.toml -o -name composer.json -o -name go.mod \
      -o -name Cargo.toml -o -name Gemfile -o -name docker-compose.yml -o -name docker-compose.yaml -o -name compose.yml \
      -o -name compose.yaml -o -name index.html -o -name index.php -o -name main.py -o -name bot.py -o -name app.py \
      -o -name '*.session' -o -name Dockerfile -o -name ecosystem.config.js \) -print 2>/dev/null
done | sed 's|/[^/]*$||' | sort -u | head -n 400 | while read -r f; do out FOLDER "$f"; done
out DONE
