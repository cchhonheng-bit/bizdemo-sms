# Caddy + layer4 (D-84): port 443 also carries SSH. layer4 sees the plain "SSH-" greeting before any TLS and hands the
# connection to the host's sshd; every other connection continues to Caddy's normal HTTPS (real client IPs kept).
# Built once on the server by remote-deploy.sh (image hangkh/caddy-l4:2.11) — networks that block port 22 still reach us.
FROM caddy:2.11-builder-alpine AS build
RUN xcaddy build --with github.com/mholt/caddy-l4
FROM caddy:2.11-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
