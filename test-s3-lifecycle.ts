import dotenv from 'dotenv';
dotenv.config();
import { S3Client, GetBucketLifecycleConfigurationCommand, GetBucketVersioningCommand, GetBucketPolicyCommand } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: 'nl-ams',
  endpoint: 'https://s3.nl-ams.scw.cloud',
  credentials: {
    accessKeyId: process.env.SCW_ACCESS_KEY!,
    secretAccessKey: process.env.SCW_SECRET_KEY!,
  },
  forcePathStyle: true,
});

const bucket = process.env.SCW_BUCKET!;

console.log('=== Bucket Policy & Lifecycle Check ===');
console.log('Bucket:', bucket);

// Check lifecycle rules
try {
  console.log('\n1. Lifecycle configuration:');
  const lifecycle = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  console.log('   Rules:', JSON.stringify(lifecycle.Rules, null, 2));
} catch (err: any) {
  if (err.name === 'NoSuchLifecycleConfiguration' || err.Code === 'NoSuchLifecycleConfiguration') {
    console.log('   No lifecycle configuration (objects won\'t auto-delete)');
  } else {
    console.log('   Error checking lifecycle:', err.name, err.message);
  }
}

// Check versioning
try {
  console.log('\n2. Versioning:');
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  console.log('   Status:', versioning.Status ?? 'Not enabled');
  console.log('   MFADelete:', versioning.MFADelete ?? 'Not enabled');
} catch (err: any) {
  console.log('   Error checking versioning:', err.name, err.message);
}

// Check bucket policy
try {
  console.log('\n3. Bucket policy:');
  const policy = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
  console.log('   Policy:', policy.Policy);
} catch (err: any) {
  if (err.name === 'NoSuchBucketPolicy' || err.Code === 'NoSuchBucketPolicy') {
    console.log('   No bucket policy set');
  } else {
    console.log('   Error checking policy:', err.name, err.message);
  }
}
