FROM pgvector/pgvector:0.8.6-pg18-bookworm@sha256:691673308c99d2161ba298736f3147f1f22d79de2fb7ec93ae9b4afcab870b62

ARG AGE_VERSION=1.3.1
ARG AGE_SHA256=bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377
ARG RCLONE_VERSION=1.74.3
ARG RCLONE_SHA256=dbee7ccd7a5d617e4ed4cd4555c16669b511abfe8d31164f61be35ac9e999bd2

RUN set -eux; \
    test "$(dpkg --print-architecture)" = 'amd64'; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      tzdata \
      unzip \
      util-linux; \
    curl -fsSLo /tmp/age.tar.gz \
      "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-amd64.tar.gz"; \
    echo "${AGE_SHA256}  /tmp/age.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/age.tar.gz -C /tmp; \
    install -m 0755 /tmp/age/age /usr/local/bin/age; \
    curl -fsSLo /tmp/rclone.zip \
      "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip"; \
    echo "${RCLONE_SHA256}  /tmp/rclone.zip" | sha256sum -c -; \
    unzip -q /tmp/rclone.zip -d /tmp; \
    install -m 0755 "/tmp/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" /usr/local/bin/rclone; \
    rm -rf /var/lib/apt/lists/* /tmp/age /tmp/age.tar.gz /tmp/rclone.zip \
      "/tmp/rclone-v${RCLONE_VERSION}-linux-amd64"

COPY --chown=postgres:postgres ops/backup/cc-memory-backup.sh /app/cc-memory-backup.sh
RUN chmod 0755 /app/cc-memory-backup.sh
RUN bash -n /app/cc-memory-backup.sh

ENV TZ=Asia/Taipei
USER postgres
CMD ["sleep", "infinity"]
