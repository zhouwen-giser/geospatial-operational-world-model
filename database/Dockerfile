ARG MOBILITYDB_BASE_IMAGE=mobilitydb/mobilitydb:18-3.6-1.3@sha256:8409e3897e2b88561bef4374110c3da5f7ff56838a7745315f1c2f111305dd24
FROM ${MOBILITYDB_BASE_IMAGE}

ARG H3_PG_VERSION=4.5.0
ARG H3_PG_SOURCE_SHA256=72f48359cd49ffaa38eb22fbaa607d5497e0144a8f94824f826beb0b370c40d8
ARG PGROUTING_VERSION=4.0.1
ARG PGROUTING_SOURCE_SHA256=21c071983a682e048da28f0f211205a20f27ef3708c0b637b4e6e29994d7d699

LABEL org.opencontainers.image.title="GOWM PostgreSQL network foundation"
LABEL org.opencontainers.image.base.name="mobilitydb/mobilitydb:18-3.6-1.3"
LABEL org.opencontainers.image.source="https://github.com/zhouwen-giser/geospatial-operational-world-model"
LABEL org.gowm.postgresql.version="18"
LABEL org.gowm.postgis.version="3.6"
LABEL org.gowm.mobilitydb.version="1.3"
LABEL org.gowm.h3-pg.version="4.5.0"
LABEL org.gowm.pgrouting.version="4.0.1"
LABEL org.gowm.pgrouting.source="https://github.com/pgRouting/pgrouting/releases/tag/v4.0.1"
LABEL org.gowm.pgrouting.source-sha256="21c071983a682e048da28f0f211205a20f27ef3708c0b637b4e6e29994d7d699"

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

# Build the exact official pgRouting release on top of the already pinned
# MobilityDB/PostGIS/H3 image. A generic pgRouting image would discard the
# required MobilityDB and h3-pg runtime and is therefore not an acceptable base.
RUN find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -exec sed -i 's|http://|https://|g' {} + \
    && for attempt in 1 2 3 4 5; do apt-get -o Acquire::Retries=5 update && break; test "$attempt" = 5 && exit 1; sleep $((attempt * 2)); done \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
       libboost-atomic1.83.0 libboost-chrono1.83.0 libboost-date-time1.83.0 \
       libboost-graph1.83.0 libboost-program-options1.83.0 libboost-system1.83.0 \
       libboost-thread1.83.0 \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
       build-essential cmake wget libboost-graph-dev libpq-dev postgresql-server-dev-18 \
    && wget --https-only --tries=5 --output-document=/tmp/pgrouting.tar.gz \
       "https://github.com/pgRouting/pgrouting/archive/v${PGROUTING_VERSION}.tar.gz" \
    && echo "${PGROUTING_SOURCE_SHA256}  /tmp/pgrouting.tar.gz" | sha256sum --check --strict \
    && mkdir -p /usr/src/pgrouting \
    && tar --extract --file /tmp/pgrouting.tar.gz --directory /usr/src/pgrouting --strip-components 1 \
    && cmake -S /usr/src/pgrouting -B /usr/src/pgrouting/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /usr/src/pgrouting/build --parallel 2 \
    && cmake --install /usr/src/pgrouting/build \
    && grep -qx "default_version = '${PGROUTING_VERSION}'" /usr/share/postgresql/18/extension/pgrouting.control \
    && apt-mark manual postgresql-18 \
    && apt-get purge -y --auto-remove \
       build-essential cmake wget libpq-dev libboost-graph-dev postgresql-server-dev-18 \
    && rm -rf /tmp/pgrouting.tar.gz /usr/src/pgrouting /var/lib/apt/lists/*

COPY database/licenses/pgRouting-GPL-2.0.txt /usr/share/doc/gowm-pgrouting/LICENSE
COPY database/THIRD_PARTY_NOTICES.md /usr/share/doc/gowm-pgrouting/THIRD_PARTY_NOTICES.md
COPY database/sbom/gowm-db.spdx.json /usr/share/doc/gowm-pgrouting/gowm-db.spdx.json
