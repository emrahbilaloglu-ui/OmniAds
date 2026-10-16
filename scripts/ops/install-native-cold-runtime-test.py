"""Operator preflight only: mocked Docker transport; no SSH/DB/host mutations."""
import importlib.util
import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.realpath(os.path.join(os.path.dirname(__file__), '../native-cold-lifecycle')))
spec=importlib.util.spec_from_file_location('cold_runtime_operator', os.path.join(os.path.dirname(__file__),'install-native-cold-runtime.py'))
op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)
BUILD='a'*40
KEY='b'*64


class RuntimePreflight(unittest.TestCase):
    def setUp(self):
        self.request={'buildId':BUILD,'sourceInventorySha256':op.RUNTIME_INVENTORY,'keySha256':KEY}
        self.inventory={'files':[{'path':'docker-compose.yml','bytes':123,'sha256':'c'*64}]}
        self.roles={}
        for name in ('web','worker','archive-erasure'):
            mounts=[] if name=='worker' else [{'destination':'/run/'+destination,'source':op.APP+'/'+source,
                'type':'bind','writable':name=='archive-erasure'} for destination,source in
                [('adsecute-native-archive','native-archive'),('adsecute-business-erasure','business-erasure-control')]]
            self.roles[name]={'running':True,'buildId':BUILD,'immutableBuildId':BUILD,'ociRevision':BUILD,
                'imageRole':'web-runner' if name=='web' else 'worker-runner','archive':{'keySha256':KEY},'mounts':mounts}
        self.observed={'contract':'native-cold-runtime-observation.v1','valid':True,'roles':self.roles}
        self.proof={'inventory':op.RUNTIME_INVENTORY,'build':BUILD,'immutable':BUILD}

    def verify(self):
        with patch.object(op,'observe',return_value=self.observed), patch.object(op,'read_file',return_value=b'compose') as read, \
             patch.object(op,'compose',return_value=json.dumps(self.proof).encode()) as command, \
             patch.object(op,'run',side_effect=AssertionError('host Git must never stand in for runtime identity')):
            result=op.verify_live_runtime(self.request,self.inventory)
            read.assert_called_once_with(op.APP+'/docker-compose.yml',123,'c'*64,123)
            args=command.call_args.args[0]
            self.assertIn('NATIVE_COLD_SOURCE_INVENTORY_SHA256='+op.RUNTIME_INVENTORY,args)
            self.assertNotIn('NATIVE_COLD_LIFECYCLE_ENABLED=true',args)
            return result

    def test_uses_live_source_bytes_without_reading_or_relabeling_the_frozen_host_checkout(self):
        self.assertEqual(self.verify()['runtimeFilesVerified'],1)

    def test_rejects_relabelled_image_even_when_compose_build_id_matches(self):
        self.roles['web']['immutableBuildId']='d'*40
        with self.assertRaisesRegex(ValueError,'runtime_image_identity_differs'): self.verify()

    def test_rejects_wrong_role_or_stopped_container(self):
        for field,value in [('imageRole','web-runner'),('running',False)]:
            old=self.roles['archive-erasure'][field];self.roles['archive-erasure'][field]=value
            with self.assertRaises(ValueError): self.verify()
            self.roles['archive-erasure'][field]=old

    def test_rejects_provider_archive_access_and_writable_web_scope(self):
        self.roles['worker']['mounts']=self.roles['web']['mounts']
        with self.assertRaisesRegex(ValueError,'provider_worker_must_be_archive_free'): self.verify()
        self.roles['worker']['mounts']=[];self.roles['web']['mounts'][0]['writable']=True
        with self.assertRaisesRegex(ValueError,'runtime_mount_scope_differs'): self.verify()

    def test_requires_actual_source_inventory_and_immutable_build_proof(self):
        for field in ('inventory','build','immutable'):
            old=self.proof[field];self.proof[field]='wrong'
            with self.assertRaisesRegex(ValueError,'actual_runtime_source_differs'): self.verify()
            self.proof[field]=old

    def test_rejects_offline_key_mismatch(self):
        self.roles['web']['archive']['keySha256']='e'*64
        with self.assertRaisesRegex(ValueError,'actual_key_recovery_differs'): self.verify()

    def test_host_compose_drift_is_not_ignored(self):
        with patch.object(op,'observe',return_value=self.observed),patch.object(op,'read_file',side_effect=ValueError('host_compose_drift')):
            with self.assertRaisesRegex(ValueError,'host_compose_drift'): op.verify_live_runtime(self.request,self.inventory)


if __name__=='__main__':unittest.main()
