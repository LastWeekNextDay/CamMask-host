/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onRequest} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const {getStorage} = require("firebase-admin/storage");
const crypto = require("crypto");
const Busboy = require('busboy');
const path = require('path');
const os = require('os');
const fs = require('fs');

initializeApp();
const db = getFirestore();
const storage = getStorage()
const bucket = storage.bucket();

exports.helloWorld = onRequest((request, response) => {
   logger.info("Hello logs!", {structuredData: true});
   response.send("Hello from Firebase!");
});

exports.createUser = onRequest(async (req, res) => {
   logger.info('Got creating user request\n', req.body);

   if (req.method !== 'POST') {
      logger.error('createUser: Method not allowed (expected POST)');
      res.status(405).send('Method not allowed');
      return;
   }

   const {googleId} = req.body;
   if (!googleId) {
      logger.error('createUser: Missing googleId');
      res.status(400).send('Missing googleId');
      return;
   }

   const {name} = req.body;
   if (!name) {
      logger.error('createUser: Missing name');
      res.status(400).send('Missing name');
      return;
   }

   const {photoUrl} = req.body;

   logger.info('createUser: Checking if user with googleId ', googleId, ' already exists');
   const userRef = await db.collection('users').doc(googleId);
   const user = await userRef.get();
   if (user.exists) {
      logger.error('createUser: User already exists');
      res.status(400).send('User already exists');
   }

   logger.info('createUser: Creating user with googleId ', googleId);
   const now = new Date().toISOString();
   await db.collection('users').doc(googleId).set({
      id: googleId,
      name: name,
      photoUrl: photoUrl,
      canComment: true,
      canUpload: true,
      creationDate: now,
      lastAccess: now
   });

   res.status(200).send('User created');
});

exports.getUser = onRequest(async (req, res) => {
   logger.info('Got getting user request with params:', req.params);
   if (req.method !== 'GET') {
      logger.error('getUser: Method not allowed (expected GET)');
      res.status(405).send('Method not allowed');
      return;
   }

   const googleId = req.query.googleId;
   if (!googleId) {
      logger.error('getUser: Missing googleId');
      res.status(400).send('Missing googleId');
      return;
   }

   logger.info('getUser: Getting user with googleId ', googleId);
   const userRef = db.collection('users').doc(googleId);
   const user = await userRef.get();

   if (!user.exists) {
      logger.error('getUser: User not found');
      res.status(200).json({});
      return;
   }

   logger.info('getUser: User found, updating lastAccess');
   const now = new Date().toISOString();
   await userRef.update({
      lastAccess: now
   });

   logger.info('getUser: Returning user data');
   res.status(200).json(user.data());
});

exports.uploadFile = onRequest(async (req, res) => {
   logger.info('Got file upload request');

   if (req.method !== 'POST') {
      logger.error('uploadFile: Method not allowed (expected POST)');
      res.status(405).send('Method not allowed');
      return;
   }

   try {
      const busboy = Busboy({
         headers: req.headers,
         limits: {
            fileSize: 100 * 1024 * 1024,
         }
      });
      const uploads = [];
      const fields = {};
      const tmpdir = os.tmpdir();

      busboy.on('field', (fieldname, val) => {
         logger.info(`Processing field: ${fieldname}`);
         fields[fieldname] = val;
      });

      busboy.on('file', (fieldname, fileStream, fileInfo) => {
         logger.info(`Processing file: ${fileInfo.filename}, type: ${fileInfo.mimeType}`);

         const uniqueFilename = `${crypto.randomUUID()}-${fileInfo.filename}`;
         const filepath = path.join(tmpdir, uniqueFilename);
         const writeStream = fs.createWriteStream(filepath);

         const uploadPromise = new Promise((resolve, reject) => {
            fileStream.pipe(writeStream)
                .on('error', error => {
                   fileStream.resume();
                   reject(error);
                });

            writeStream.on('error', error => {
               fileStream.resume();
               reject(error);
            });

            writeStream.on('finish', async () => {
               let options;
               try {
                  options = {
                     destination: uniqueFilename,
                     metadata: {
                        contentType: fileInfo.mimeType,
                        metadata: {
                           originalName: fileInfo.filename
                        }
                     }
                  }
                  const [uploadedFile] = await bucket.upload(filepath, options);

                  await uploadedFile.makePublic();
                  const publicUrl = `https://firebasestorage.googleapis.com/v0/b/cammask-d31a3.appspot.com/o/${encodeURIComponent(uniqueFilename)}?alt=media`;

                  fs.unlink(filepath, (err) => {
                     if (err) logger.error('Error removing temp file:', err);
                  });

                  resolve({
                     fieldname,
                     originalName: fileInfo.filename,
                     url: publicUrl
                  });
               } catch (error) {
                  reject(error);
               }
            });
         });

         uploads.push(uploadPromise);
      })

      const uploadComplete = new Promise((resolve, reject) => {
         busboy.on('finish', () => {
            logger.info('Busboy finished processing');
            Promise.all(uploads)
                .then(uploadResults => {
                   resolve({ fields, files: uploadResults });
                })
                .catch(reject);
         });

         busboy.on('error', error => {
            logger.error('Busboy encountered an error:', error);
            reject(error);
         });
      });

      busboy.end(req.rawBody);

      const result = await uploadComplete;

      logger.info('uploadFile: Files uploaded successfully', result);
      res.status(200).json(result);

   } catch (error) {
      logger.error('uploadFile: Error uploading file', error);
      if (error.code === 'LIMIT_FILE_SIZE') {
         res.status(413).json({ error: 'File too large' });
      } else {
         res.status(500).json({ error: 'Error uploading file' });
      }
   }
});

exports.createMask = onRequest(async (req, res) => {
   logger.info('Got create mask request');

   if (req.method !== 'POST') {
      logger.error('createMask: Method not allowed (expected POST)');
      res.status(405).send('Method not allowed');
      return;
   }

   try {
      const {
         maskUrl,
         name,
         description,
         images,
         tags,
         uploaderGoogleId
      } = req.body;

      if (maskUrl === "" || maskUrl == null) {
            logger.error('createMask: maskUrl is empty');
            res.status(400).send('maskUrl is empty');
            return;
      }

      if (name === "" || name == null) {
            logger.error('createMask: name is empty');
            res.status(400).send('name is empty');
            return;
      }

      if (uploaderGoogleId === "" || uploaderGoogleId == null) {
            logger.error('createMask: uploaderGoogleId is empty');
            res.status(400).send('uploaderGoogleId is empty');
            return;
      }

      if (images === "" || images == null) {
            logger.error('createMask: images is empty');
            res.status(400).send('images is empty');
            return;
      }

      const userRef = await db.collection('users').doc(uploaderGoogleId).get();
      if (!userRef.exists) {
         logger.error('createMask: User not found');
         res.status(404).send('User not found');
         return;
      }

      if (!userRef.data().canUpload) {
         logger.error('createMask: User cannot upload');
         res.status(403).send('User is not allowed to upload');
         return;
      }

      const masksSnapshot = await db.collection('masks').orderBy('id').get();
      let nextId = 0;

      masksSnapshot.forEach(doc => {
         const maskData = doc.data();
         if (maskData.id === nextId) {
            nextId++;
         }
      });

      const now = new Date().toISOString();
      const maskData = {
         id: nextId,
         maskUrl,
         name,
         description: description || '',
         images,
         tags: tags || [],
         uploaderGoogleId,
         uploadedOn: now,
         lastAccessedOn: now,
         isRemoved: false
      };

      await db.collection('masks').doc(nextId.toString()).set(maskData);

      logger.info('createMask: Mask created successfully with ID:', nextId);
      res.status(200).json({
         success: true,
         maskId: nextId
      });

   } catch (error) {
      logger.error('createMask: Error creating mask', error);
      res.status(500).json({
         success: false,
         error: 'Error creating mask: ' + error
      });
   }
});