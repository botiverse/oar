import { expect, test } from "vitest";
import { comparePluginEnvironment } from "../../experiments/sharing/plugin-environment-comparison.js";

const cohort = (placement: string, childHome = false) => ({ placement, errors: [], processHome: '/home', sessionCwds: ['/a', '/b'],
  evidence: { hooks: ['/a', '/b'].map(location => ({ location, environmentMarker: 'oar-execution-fixture', child: { cwd: childHome ? '/home' : location, environmentMarker: 'oar-execution-fixture' } })) } });
test('configured plugin children distinguish session cwd from shared HOME', () => {
  const actual = comparePluginEnvironment(cohort('shared', true), cohort('isolated'));
  expect(actual.passed).toBe(false); expect(actual.failures).toHaveLength(1);
});
test('matching observed children pass; two absent observations cannot pass', () => {
  expect(comparePluginEnvironment(cohort('shared'), cohort('isolated'))).toEqual({ passed: true, failures: [] });
  expect(comparePluginEnvironment({ errors: [] }, { errors: [] }).passed).toBe(false);
});
test('an error or a missing environment marker cannot be hidden by equal cwd', () => {
  expect(comparePluginEnvironment({ ...cohort('shared'), errors: ['failed'] }, cohort('isolated')).passed).toBe(false);
  const source = cohort('shared');
  const missing = { ...source, evidence: { hooks: source.evidence.hooks.map(hook => ({ location: hook.location, environmentMarker: hook.environmentMarker, child: { cwd: hook.location } })) } };
  expect(comparePluginEnvironment(missing, cohort('isolated')).passed).toBe(false);
});
