"""Regression wiring only. This does not exercise Docker or certify isolation."""
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[4]
WORKFLOW = ROOT / '.github/workflows/dyoffice-web-boundaries.yml'

class DiagnosticCICoverage(unittest.TestCase):
    def workflow(self):
        return yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)

    def test_diagnostic_and_broker_changes_trigger_existing_gate(self):
        events = self.workflow()['on']
        for event in ('push', 'pull_request'):
            for path in ('deploy/docker/document-runtime-diagnostic/**', 'services/document-broker/**'):
                self.assertIn(path, events[event]['paths'])

    def test_isolated_lightweight_job_runs_actual_suite(self):
        job = self.workflow()['jobs'].get('diagnostic-regression')
        self.assertIsNotNone(job)
        self.assertEqual(job['timeout-minutes'], '5')
        self.assertNotIn('services', job)
        self.assertNotIn('container', job)
        commands = '\n'.join(s.get('run','') for s in job['steps'])
        self.assertIn('python -m unittest discover -s deploy/docker/document-runtime-diagnostic/tests -v', commands)
        self.assertIn('PyYAML==6.0.3', commands)
        self.assertNotIn('continue-on-error', str(job))
        self.assertNotIn('sudo', commands)
        self.assertNotIn('docker ', commands)
        self.assertNotIn('collect-evidence.py --', commands)
        self.assertIn('not Ubuntu/Docker isolation acceptance', commands)

    def test_syntax_checks_are_real_commands(self):
        job = self.workflow()['jobs'].get('diagnostic-regression', {})
        commands = '\n'.join(s.get('run','') for s in job.get('steps',[]))
        self.assertIn('sh -n "$script"', commands)
        self.assertIn('python -m py_compile deploy/docker/document-runtime-diagnostic/*.py', commands)

if __name__ == '__main__': unittest.main()
