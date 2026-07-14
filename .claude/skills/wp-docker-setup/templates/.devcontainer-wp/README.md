# Devcontainer URLs

Docker 起動後は以下の URL で確認できます。

- Site: https://localhost:8080
- WordPress Admin: https://localhost:8080/wordpress/wp-admin/
- phpMyAdmin: http://localhost:8084
- Adminer: http://localhost:8083
- Mailpit: http://localhost:8081
- Live Reload (BrowserSync): http://localhost:3000
- BrowserSync UI: http://localhost:3001

## Notes

- If your WP root is not `wordpress`, update the WordPress Admin path accordingly.
- If a port conflict occurs, update `docker-compose.yml` ports.

## Live Reload

- BrowserSync starts automatically on container start and attach.
- CSS changes under `assets/css/**/*.css` are injected without full page reload.
- Changes in PHP/HTML/JS trigger a full browser reload.
