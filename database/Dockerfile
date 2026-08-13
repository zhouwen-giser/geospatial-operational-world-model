ARG MOBILITYDB_BASE_IMAGE=mobilitydb/mobilitydb:18-3.6-1.3@sha256:8409e3897e2b88561bef4374110c3da5f7ff56838a7745315f1c2f111305dd24
FROM ${MOBILITYDB_BASE_IMAGE}

ARG H3_PG_VERSION=4.5.0
ARG H3_PG_SOURCE_SHA256=72f48359cd49ffaa38eb22fbaa607d5497e0144a8f94824f826beb0b370c40d8

# The validated MobilityDB image supplies PostgreSQL 18, PostGIS 3.6 and
# MobilityDB 1.3. PGDG's PG18 binary currently lags at h3-pg 4.2.3, so compile
# the official PGXN 4.5.0 release from a checksum-pinned archive.
RUN find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -exec sed -i 's|http://|https://|g' {} + \
    && for attempt in 1 2 3 4 5; do apt-get -o Acquire::Retries=5 update && break; test "$attempt" = 5 && exit 1; sleep $((attempt * 2)); done \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
       ca-certificates curl unzip cmake make gcc postgresql-server-dev-18 \
    && curl --fail --location --retry 5 --retry-all-errors \
       "https://api.pgxn.org/dist/h3/${H3_PG_VERSION}/h3-${H3_PG_VERSION}.zip" -o /tmp/h3-pg.zip \
    && echo "${H3_PG_SOURCE_SHA256}  /tmp/h3-pg.zip" | sha256sum --check --strict \
    && unzip -q /tmp/h3-pg.zip -d /tmp \
    && cmake -S "/tmp/h3-${H3_PG_VERSION}" -B /tmp/h3-build -DBUILD_TESTING=OFF -DPOSTGRESQL_VERSION=18 \
    && cmake --build /tmp/h3-build --parallel 2 \
    && cmake --install /tmp/h3-build --component h3-pg \
    && grep -qx "default_version = '${H3_PG_VERSION}'" /usr/share/postgresql/18/extension/h3.control \
    && grep -qx "default_version = '${H3_PG_VERSION}'" /usr/share/postgresql/18/extension/h3_postgis.control \
    && apt-get purge -y --auto-remove cmake make gcc postgresql-server-dev-18 unzip \
    && rm -rf /tmp/h3-pg.zip /tmp/h3-build "/tmp/h3-${H3_PG_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
