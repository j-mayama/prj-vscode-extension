# @see https://docs.docker.com/reference/dockerfile/

# @see https://hub.docker.com/_/php
FROM php:8.5.3-fpm

RUN apt-get update && apt-get install -y \
      libpng-dev \
      libjpeg62-turbo-dev \
      libfreetype6-dev \
      libzip-dev \
      libonig-dev \
      libmagickwand-dev \
      imagemagick \
      msmtp \
      msmtp-mta \
      unzip \
      curl \
  && docker-php-ext-configure gd --with-freetype --with-jpeg \
  && docker-php-ext-install -j$(nproc) gd mysqli pdo_mysql zip mbstring opcache \
  && pecl install imagick \
  && docker-php-ext-enable imagick \
  && echo 'sendmail_path = "/usr/bin/msmtp -t"' > /usr/local/etc/php/conf.d/sendmail.ini \
  && rm -rf /var/lib/apt/lists/*

# @see https://ja.wordpress.org/download/releases/
ENV WORDPRESS_VERSION=6.9.1
ENV WORDPRESS_LOCALE=ja
RUN mkdir -p /usr/src/wordpress \
  && (curl -o /tmp/wordpress.tar.gz -fSL \
      https://ja.wordpress.org/wordpress-${WORDPRESS_VERSION}-${WORDPRESS_LOCALE}.tar.gz \
      || curl -o /tmp/wordpress.tar.gz -fSL \
      https://ja.wordpress.org/latest-ja.tar.gz) \
  && tar -xzf /tmp/wordpress.tar.gz -C /usr/src/wordpress --strip-components=1 \
  && rm /tmp/wordpress.tar.gz

RUN chown -R www-data:www-data /var/www/html

COPY msmtprc /etc/msmtprc
