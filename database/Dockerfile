FROM postgis/postgis:17-3.5

ARG H3_PG_VERSION=4.5.0

# The PostGIS image already configures the PGDG repository. Install the
# PostgreSQL-version-specific h3-pg binary package, then fail the build if the
# resolved upstream version is not the reviewed version.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17-h3 \
    && installed_version="$(dpkg-query -W -f='${Version}' postgresql-17-h3)" \
    && case "$installed_version" in "${H3_PG_VERSION}"*) ;; *) echo "Expected h3-pg ${H3_PG_VERSION}, got ${installed_version}" >&2; exit 1 ;; esac \
    && rm -rf /var/lib/apt/lists/*
