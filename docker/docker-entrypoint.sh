#!/bin/sh
set -e

if [ -f /usr/share/nginx/html/config.js.template ]; then
  export AUTO_CONNECT="${AUTO_CONNECT:-true}"
  envsubst '${ANON_KEY} ${AUTO_CONNECT}' \
    < /usr/share/nginx/html/config.js.template \
    > /usr/share/nginx/html/config.js
fi

exec nginx -g 'daemon off;'
