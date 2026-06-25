FROM nginx:1.27-alpine

RUN apk add --no-cache gettext imagemagick font-dejavu \
  && convert -size 192x192 xc:'#6c63ff' \
     -fill white -gravity center -font DejaVu-Sans-Bold -pointsize 72 \
     -annotate 0 'TL' /usr/share/nginx/html/icon-192.png \
  && convert -size 512x512 xc:'#6c63ff' \
     -fill white -gravity center -font DejaVu-Sans-Bold -pointsize 200 \
     -annotate 0 'TL' /usr/share/nginx/html/icon-512.png

COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/default.conf.template /etc/nginx/conf.d/default.conf
COPY docker/config.js.template /usr/share/nginx/html/config.js.template
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
COPY index.html manifest.json sw.js /usr/share/nginx/html/

RUN chmod +x /docker-entrypoint.sh \
  && echo 'window.TIMELOG_CONFIG = {};' > /usr/share/nginx/html/config.js

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
