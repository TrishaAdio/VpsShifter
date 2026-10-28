# Shift probe — quick system facts (read only, no root needed)
os_detect; pm_detect
mem=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
swap=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null)
disk=$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}')
cpus=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
tools=
for t in rsync ssh tar curl wget gzip base64 setsid systemd-run sudo crontab screen tmux docker nginx apache2 httpd caddy php node python3 \
         git supervisorctl mysql psql redis-cli mongod ufw firewall-cmd iptables getenforce visudo useradd adduser ss netstat; do
  have "$t" && tools="$tools $t"
done
rsv=; have rsync && rsv=$(rsync --version 2>/dev/null | head -n1 | awk '{print $3}')
out PROBE "$OS_ID" "$OS_LIKE" "$OS_VER" "$OS_NAME" "$(uname -m)" "$(libc_kind)" "$(init_kind)" "$PM" \
  "$(hostname 2>/dev/null || cat /etc/hostname)" "$OS_FAMILY" "${mem:-0}" "${swap:-0}" "${disk:-0}" "${cpus:-1}" "$tools" \
  "$(id -u)" "$(id -un)" "$OS_CODENAME" "$rsv" "$(uptime 2>/dev/null | sed 's/.*up \([^,]*\),.*/\1/')"
for k in /etc/ssh/ssh_host_*_key.pub; do [ -r "$k" ] && out HOSTKEY "$(cat "$k")"; done
for d in /var/lib/docker /home /var /opt /srv; do [ -d "$d" ] && out DF "$d" "$(df -Pk "$d" 2>/dev/null | awk 'NR==2{print $4" "$6}')"; done
[ -f /var/tmp/shift/lock ] && out LOCK "$(cat /var/tmp/shift/lock 2>/dev/null)"
out BOOT "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)|$(cat /etc/machine-id 2>/dev/null)|$(hostname 2>/dev/null)"
exit 0
