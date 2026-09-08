import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = 'database/shared-business-storage';
const smpp = process.argv[2], sdar = process.argv[3];
if (!smpp || !sdar)
    throw Error('usage: vendor.mjs <read-only SMPP checkout> <read-only SDAR checkout>');
const sha = s => createHash('sha256').update(s).digest('hex');
const specs = [['SMPP_RUNTIME', smpp, 'migrations/runtime', 'ugv_smpp'], ['UGV_PROVIDER', smpp, 'migrations/providers/ugv', 'ugv_smpp'], ['SDAR_RUNTIME', sdar, 'infra/postgres/baseline', 'ugv_sdar'], ['SDAR_RUNTIME', sdar, 'infra/postgres/migrations', 'ugv_sdar']];
const entries = [];
for (const [family, repo, dir, schema] of specs) {
    for (const file of (await readdir(`${repo}/${dir}`)).sort()) {
        if (!file.endsWith('.sql'))
            continue;
        if (dir.endsWith('/migrations') && !/^(?:01[0-9]{2}_v(?:123|13|14)_[a-z0-9_]+|0173_remote_task_accepted_substate)\.up\.sql$/.test(file))
            continue;
        const raw = await readFile(`${repo}/${dir}/${file}`, 'utf8'), sql = raw.replace(/\r\n?/g, '\n');
        const path = `upstream/${family}/${file}`;
        await mkdir(`${root}/upstream/${family}`, { recursive: true });
        await writeFile(`${root}/${path}`, sql);
        entries.push({ family, schema, file, sourcePath: `${dir}/${file}`, commit: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), rawSha256: sha(raw), sha256: sha(sql), path });
    }
}
await writeFile(`${root}/sources.json`, JSON.stringify({ repositories: { SMPP_RUNTIME: 'https://github.com/zhouwen-giser/sdar-mcp-provider-platform', UGV_PROVIDER: 'https://github.com/zhouwen-giser/sdar-mcp-provider-platform', SDAR_RUNTIME: 'https://github.com/zhouwen-giser/skill-driven-agent-runtime' }, hashConvention: 'SHA-256 UTF-8 LF (raw hash also retained)', entries }, null, 2) + '\n');
