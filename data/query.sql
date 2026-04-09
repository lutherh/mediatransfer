SELECT id, "originalPath" 
FROM asset 
WHERE status = 'active' AND "deletedAt" IS NULL 
AND (
  "originalPath" = '/usr/src/app/upload/library/admin/2016/2016-01-04/IMG_20160104_160210.jpg'
  OR "originalPath" = '/usr/src/app/upload/library/admin/2017/2017-09-09/20170909_143037.jpg'
  OR "originalPath" = '/usr/src/app/upload/library/admin/2024/2024-03-16/IMG_3275.heic'
  OR "originalPath" = '/usr/src/app/upload/library/admin/2026/2026-04-02/IMG_6305.heic'
  OR "originalPath" = '/usr/src/app/upload/library/admin/2026/2026-04-02/IMG_3219.jpg'
);