# wp-docker-setup README

このスキルで生成される WP ローカル環境の利用ガイド。

## Docker 起動後のアクセス URL

- サイト本体: https://localhost:8080
- WordPress 管理画面: https://localhost:8080/wordpress/wp-admin/
- phpMyAdmin: http://localhost:8084
- Adminer: http://localhost:8083
- Mailpit: http://localhost:8081

## 補足

- 証明書警告が出る場合は、ローカル開発環境のためブラウザで続行して確認してください。
- WP ルートディレクトリが `wordpress` 以外の場合、管理画面 URL のパス部分を置き換えてください。
- ポート競合がある場合は `.devcontainer/docker-compose.yml` の `ports` 設定を変更してください。
