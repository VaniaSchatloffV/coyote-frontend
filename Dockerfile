FROM nginx:alpine

RUN apk add --no-cache gettext

COPY public/ /usr/share/nginx/html/
COPY nginx/default-with-proxy.conf.template /etc/nginx/templates/
COPY nginx/default-static-only.conf.template /etc/nginx/templates/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh \
    && rm -f /etc/nginx/conf.d/default.conf

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
