#!/bin/sh
# WordPress 初期設定スクリプト
# - WP コアファイルをコピー（既存ファイルは上書きしない）
# - wp-config.php が存在しない場合のみ作成（DB値含む）
# - wp-config.php が存在する場合は一切変更しない
set -e

WP_ROOT="/var/www/html/{{WP_ROOT}}"
WP_CONFIG="$WP_ROOT/wp-config.php"

DB_NAME="${WORDPRESS_DB_NAME:-database}"
DB_USER="${WORDPRESS_DB_USER:-user}"
DB_PASSWORD="${WORDPRESS_DB_PASSWORD:-password}"
DB_HOST="${WORDPRESS_DB_HOST:-sql}"
TABLE_PREFIX="${WORDPRESS_TABLE_PREFIX:-wp_}"

# ディレクトリが存在しない場合は作成
mkdir -p "$WP_ROOT"

# wp-config.php がディレクトリの場合は、内容を消さずに停止する
if [ -d "$WP_CONFIG" ]; then
  echo "[init-wp-config] ERROR: wp-config.php is a directory; fix it manually: $WP_CONFIG" >&2
  exit 1
fi

# WP コアファイルをコピー（既存ファイルは上書きしない）
cp -a -n /usr/src/wordpress/. "$WP_ROOT"

if [ ! -f "$WP_CONFIG" ]; then
  # wp-config.php が存在しない → 新規作成（DB値含む全値を書き込む）
  cat > "$WP_CONFIG" << EOF
<?php
/**
 * WordPress base configuration for local Docker environment.
 */

// ** Database settings ** //
define( 'DB_NAME', '$DB_NAME' );
define( 'DB_USER', '$DB_USER' );
define( 'DB_PASSWORD', '$DB_PASSWORD' );
define( 'DB_HOST', '$DB_HOST' );
define( 'DB_CHARSET', 'utf8' );
define( 'DB_COLLATE', '' );
define( 'WPLANG', 'ja' );

/**#@+
 * Authentication unique keys and salts.
 */
define( 'AUTH_KEY',         'local-auth-key-change-me' );
define( 'SECURE_AUTH_KEY',  'local-secure-auth-key-change-me' );
define( 'LOGGED_IN_KEY',    'local-logged-in-key-change-me' );
define( 'NONCE_KEY',        'local-nonce-key-change-me' );
define( 'AUTH_SALT',        'local-auth-salt-change-me' );
define( 'SECURE_AUTH_SALT', 'local-secure-auth-salt-change-me' );
define( 'LOGGED_IN_SALT',   'local-logged-in-salt-change-me' );
define( 'NONCE_SALT',       'local-nonce-salt-change-me' );
/**#@-*/
\$table_prefix = '$TABLE_PREFIX';

define( 'WP_DEBUG', false );

/* That's all, stop editing! Happy publishing. */
if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
EOF
  echo "[init-wp-config] Created wp-config.php"
else
  # 既存設定は本番・検証環境由来の値を含み得るため、明示的な修復操作なしでは変更しない。
  # DB値・table_prefix・WPLANGの同期は setup-wp-config スキルが担当する。
  echo "[init-wp-config] wp-config.php exists; left unchanged"
fi
