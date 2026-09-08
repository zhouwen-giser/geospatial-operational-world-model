export interface DeviceRoute {
    device_id: string;
    endpoint_id: string;
    topic_filter: string;
    identity_mode: 'BOUND_DEVICE' | 'TOPIC' | 'PAYLOAD';
    identity_rule: {
        segment?: number | undefined;
        path?: string[] | undefined;
        equals?: string | undefined;
    };
    enabled: boolean;
}
export function validateTopicFilter(filter: string) { const p = filter.split('/'); if (!filter || p.some((v, i) => (v.includes('#') && (v !== '#' || i !== p.length - 1)) || (v.includes('+') && v !== '+')))
    throw Error('INVALID_TOPIC_FILTER'); }
export function topicMatches(filter: string, topic: string) { validateTopicFilter(filter); if (topic.startsWith('$') && (filter.startsWith('+') || filter.startsWith('#')))
    return false; const f = filter.split('/'), t = topic.split('/'); for (let i = 0; i < f.length; i++) {
    if (f[i] === '#')
        return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i]))
        return false;
} return f.length === t.length; }
export function filtersOverlap(a: string, b: string) { validateTopicFilter(a); validateTopicFilter(b); if ((a.startsWith('$') && (b.startsWith('#') || b.startsWith('+'))) || (b.startsWith('$') && (a.startsWith('#') || a.startsWith('+'))))
    return false; const x = a.split('/'), y = b.split('/'); for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === '#' || y[i] === '#')
        return true;
    if (x[i] === undefined || y[i] === undefined)
        return false;
    if (x[i] !== '+' && y[i] !== '+' && x[i] !== y[i])
        return false;
} return true; }
export function resolveIngestDevice(routes: readonly DeviceRoute[], endpointId: string, topic: string, payload: unknown): {
    status: 'MATCH';
    deviceId: string;
} | {
    status: 'NO_MATCH' | 'AMBIGUOUS';
} {
    const ids = new Set<string>();
    for (const r of routes) {
        if (!r.enabled || r.endpoint_id !== endpointId || !topicMatches(r.topic_filter, topic))
            continue;
        let value: unknown;
        if (r.identity_mode === 'BOUND_DEVICE') {
            ids.add(r.device_id);
            continue;
        }
        if (r.identity_mode === 'TOPIC') {
            if (!Number.isInteger(r.identity_rule.segment) || r.identity_rule.segment! < 0)
                throw Error('INVALID_TOPIC_RULE');
            value = topic.split('/')[r.identity_rule.segment!];
        }
        else {
            if (!r.identity_rule.path?.length)
                throw Error('INVALID_PAYLOAD_RULE');
            value = payload;
            for (const part of r.identity_rule.path) {
                if (['__proto__', 'prototype', 'constructor'].includes(part))
                    throw Error('INVALID_PAYLOAD_PATH');
                value = value && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
            }
        }
        if (typeof r.identity_rule.equals !== 'string' || !r.identity_rule.equals)
            throw Error('IDENTITY_EQUALS_REQUIRED');
        if (value === r.identity_rule.equals)
            ids.add(r.device_id);
    }
    if (ids.size === 1)
        return { status: 'MATCH', deviceId: [...ids][0]! };
    return { status: ids.size ? 'AMBIGUOUS' : 'NO_MATCH' };
}
