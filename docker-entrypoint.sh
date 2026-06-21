#!/bin/sh
set -eu

API_BASE_URL="${API_BASE_URL:-/api/v1}"
API_PROXY_ENABLED="${API_PROXY_ENABLED:-true}"
API_UPSTREAM="${API_UPSTREAM:-http://host.docker.internal:8000}"

cat > /usr/share/nginx/html/config.js <<EOF
window.__COYOTE_CONFIG__ = {
  apiBase: "${API_BASE_URL}"
};
EOF

if [ "$API_PROXY_ENABLED" = "true" ]; then
  export API_UPSTREAM
  envsubst '$API_UPSTREAM' < /etc/nginx/templates/default-with-proxy.conf.template \
    > /etc/nginx/conf.d/default.conf
else
  cp /etc/nginx/templates/default-static-only.conf.template \
    /etc/nginx/conf.d/default.conf
fi

exec nginx -g 'daemon off;'
