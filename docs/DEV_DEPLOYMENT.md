# Complete development server deployment

This package starts the complete GOWM+ development platform, including the
project-owned CRS and Geometry upstreams and both Provider Bridges. It is a
development topology for a trusted LAN or VPN, not a public-internet topology.

## Requirements

- Linux x86-64
- Docker Engine 24 or newer with Docker Compose v2
- 4 CPU, 8 GiB RAM and 20 GiB free disk minimum; 8 CPU and 16 GiB RAM recommended
- outbound access to the configured container registry and npm registry
- Node.js 22 (used by configuration validation); npm and Git are needed only
  when rebuilding the H3 binding outside the release archive

The scripts do not install Docker and do not change the host firewall. Restrict
all published ports to trusted source networks before starting the stack.

## One-command start

```bash
tar -xzf gowm-dev-server-0.7.1.tar.gz
cd gowm-dev-server-0.7.1
./scripts/dev-deploy.sh up
```

The first run creates `.env` with mode `0600`, generates independent random
credentials, verifies the H3 artifact, builds the CRS/Geometry upstream images,
records the deployed `proj.db` and offline-grid attestations, renders Compose,
runs migrations, starts all required services, and waits for health checks.
Re-running the command retains credentials and data.

Useful commands:

```bash
./scripts/dev-deploy.sh doctor
./scripts/dev-deploy.sh status
./scripts/dev-deploy.sh logs world-capability-gateway
./scripts/dev-deploy.sh smoke
./scripts/dev-deploy.sh down
```

`down` intentionally retains named volumes. No deploy command deletes the
database or MQTT data.

## Published endpoints

All host ports and the bind address can be changed in `.env`.

| Service | Default port | Authentication boundary |
|---|---:|---|
| PostgreSQL | 5432 | generated PostgreSQL password |
| MQTT | 1883 | anonymous development broker |
| World API | 3000 | trusted-network only |
| MCP | 3001 | trusted-network only; Gateway calls carry the generated token |
| Observation API | 3002 | trusted-network only |
| STAS | 8080 | trusted-network only |
| World Capability Gateway | 8090 | `GATEWAY_AUTH_SHARED_TOKEN` for protected operations |
| CRS upstream / Geometry upstream | 18080 / 18081 | trusted-network only |
| CRS / Geometry Bridges | 18086 / 18087 | corresponding Provider transport token |
| H3 interactive / analysis | 18088 / 18089 | corresponding Provider transport token |
| Reference / Dataset Providers | 18090 / 18091 | corresponding Provider transport token |
| Situation / Evidence Providers | 18092 / 18093 | corresponding Provider transport token |
| Operational / Validation Providers | 18094 / 18095 | corresponding Provider transport token |
| Network / Route Providers | 18096 / 18097 | corresponding Provider transport token |
| Coverage / STAS Providers | 18098 / 18099 | corresponding Provider transport token |
| Historical / Spatial Providers | 18100 / 18101 | corresponding Provider transport token |

Read a secret only on the deployment host, for example:

```bash
gateway_token="$(awk -F= '$1=="GATEWAY_AUTH_SHARED_TOKEN"{print $2}' .env)"
curl -H "Authorization: Bearer ${gateway_token}" http://127.0.0.1:8090/v1/operation-availability
```

Do not paste `.env`, tokens, passwords, delegated keys, or authenticated request
headers into logs or support tickets.

## Configuration and upgrades

`.env.example` is the canonical catalog for deployment variables. Each group
documents units and defaults; generated passwords and tokens must remain
distinct. Validate changes before restart:

```bash
npm run validate:deployment-env
./scripts/dev-deploy.sh doctor
```

For an application update, unpack the new package in a separate directory,
copy the private `.env` only after reviewing template changes, point Compose at
the existing approved volumes/project name, and run `up`. Migrations are
forward-only; take and test a backup before upgrading retained data.

## Security boundary

The development override binds all ports to `0.0.0.0`. MQTT remains anonymous,
and Foundation APIs do not gain a new authentication layer. Use host or network
firewall rules to allow only the trusted LAN/VPN CIDRs. Do not expose this
topology directly to the public internet.
