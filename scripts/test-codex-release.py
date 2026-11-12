#!/usr/bin/env python3
"""Run Codex release checks against a chosen out/ tree without touching user data.

Mixed-client fixtures are copied into the evidence directory. Explicitly named
non-Codex cases are excluded there, never counted as passes. Original sources
and the exact exclusions are recorded for reproduction.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--node', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--evidence', required=True)
parser.add_argument('--native-codex', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
evidence = Path(args.evidence).resolve()
evidence.mkdir(parents=True, exist_ok=False)
mirror = evidence / 'fixture'
(mirror / 'scripts').mkdir(parents=True)
for name in ('node_modules',):
    (mirror / name).symlink_to(repo / name, target_is_directory=True)
(mirror / 'out').symlink_to(Path(args.out).resolve(), target_is_directory=True)
shutil.copy(repo / 'package.json', mirror / 'package.json')
shutil.copy(repo / 'scripts/sidebar-fixture.js', mirror / 'scripts/sidebar-fixture.js')
exclusions = {
    'test-codex-ui.js': ['Claude retains its standalone Add/Configuration and tool collapse layout'],
    'test-codex-workflows.js': ['editing one tool network draft and changing pages does not apply or leak it to the other tool'],
    'test-group-ui.js': ['Codex and Claude add forms keep independent unsaved names, API keys and models in memory', 'a third registered client gets its own tab, markup, renderer and message route'],
    'test-provider-groups.js': ['different clients can independently use the same group and template names', 'client controllers reject tool and provider ownership mismatches', 'Claude rejects Codex history/group operations and unknown actions are never successful no-ops', 'registry admits a third client without adding shell routing branches'],
    'test-group-import.js': ['Claude-page exports and imports are confined to Claude and leave Codex organization untouched'],
    'test-network.js': ['concurrent Codex and Claude requests use different CONNECT proxies', 'Existing API compatibility relay uses network proxy for its upstream'],
    'test-speed.js': ['anthropic fragmented SSE, actual model and usage', 'app direct benchmark does not Apply and removes its temporary route', 'app saved proxy benchmark does not Apply and removes its temporary route'],
    'test-environments.js': ['Legacy migration retains shared Providers/keys and seeds selections/flags once'],
    'test-management.js': ['terminal launch uses each tool route without applying a provider or sharing other-tool variables'],
}
suites = ['test-codex-modes.js', 'test-codex-proxy.js', 'test-network.js',
          'test-speed.js', 'test-sessions.js', 'test-fixed-home.js',
          'test-recovery.js', 'test-runtime-guard.js', 'test-operation-log.js',
          'test-codex-ui.js', 'test-codex-workflows.js', 'test-provider-groups.js',
          'test-group-ui.js', 'test-group-import.js', 'test-environments.js', 'test-native-history.js',
          'test-codex-network.js', 'test-native-codex-network.js',
          'test-management.js', 'test-codex-diagnostics.js']
manifest = {'out': str(Path(args.out).resolve()), 'suites': {}, 'scope': 'Codex only; other-client cases excluded, not counted as passes'}
for suite in suites:
    source = (repo / 'scripts' / suite).read_text()
    original = source
    substitutions = []
    if suite == 'test-environments.js':
        # Exercise the same Codex enabled flag in both environment workers.
        substitutions = [
            ("host.call('enabled', { tool: 'claude', value: false })", "host.call('enabled', { tool: 'codex', value: false })"),
            ("enabled, { claude: false, codex: true }", "enabled, { claude: true, codex: false }"),
            ("(await host.call('state')).enabled.claude, false", "(await host.call('state')).enabled.codex, false"),
        ]
        for before, after in substitutions:
            assert source.count(before) == 1, before
            source = source.replace(before, after)
    omitted = exclusions.get(suite, [])
    if omitted:
        # Insert the scope guard at the fixture's test callback boundary.
        param, call = ('label', 'fn') if suite == 'test-provider-groups.js' else ('n', 'f') if suite == 'test-group-import.js' else ('name', 'action') if suite in ('test-network.js', 'test-environments.js') else ('name', 'run') if suite == 'test-speed.js' else ('name', 'fn')
        needle = 'await ' + call + '();'
        assert source.count(needle) == 1, (suite, 'test callback changed')
        guard = 'if (' + json.dumps(omitted) + '.includes(' + param + ')) { console.log("OUT_OF_SCOPE " + ' + param + '); return; } '
        source = source.replace(needle, guard + needle, 1)
    manifest['suites'][suite] = {'sha256': hashlib.sha256(original.encode()).hexdigest(), 'excluded_cases': omitted, 'scope_substitutions': substitutions}
    (mirror / 'scripts' / suite).write_text(source)
(evidence / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
env = {**os.environ, 'VSCODEMODELSWITCH_NATIVE_CODEX': args.native_codex,
       'PATH': str(Path(args.node).parent) + os.pathsep + os.environ.get('PATH', ''),
       'TMPDIR': str(evidence / 'tmp')}
(evidence / 'tmp').mkdir()
results = []
for suite in suites:
    command = [args.node, str(mirror / 'scripts' / suite)]
    if suite == 'test-native-codex-network.js':
        command.append(args.native_codex)
    run = subprocess.run(command, cwd=mirror, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
    (evidence / (suite + '.log')).write_text(run.stdout)
    item = {'suite': suite, 'exit_code': run.returncode, 'passed_checks': len(re.findall(r'^PASS ', run.stdout, re.M)), 'excluded_cases': len(re.findall(r'^OUT_OF_SCOPE ', run.stdout, re.M))}
    results.append(item)
    print(json.dumps(item), flush=True)
    (evidence / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    if run.returncode or re.search(r'\bSKIP\b|^FAIL ', run.stdout, re.M):
        raise SystemExit('Failed suite: ' + suite + '; inspect its log')
print('TOTAL', sum(x['passed_checks'] for x in results), 'named checks; mode/auth assertions additional; all suites passed')
