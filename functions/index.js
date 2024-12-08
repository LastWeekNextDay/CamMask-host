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
const {getStorage, getDownloadURL} = require("firebase-admin/storage");
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
                  const downloadUrl = await getDownloadURL(uploadedFile);

                  fs.unlink(filepath, (err) => {
                     if (err) logger.error('Error removing temp file:', err);
                  });

                  resolve({
                     fieldname,
                     originalName: fileInfo.filename,
                     url: downloadUrl
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
         maskUrl: maskUrl,
         maskName: name,
         description: description || '',
         images: images,
         tags: tags || [],
         uploaderGoogleId:uploaderGoogleId,
         averageRating: 0,
         ratingsCount: 0,
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

exports.getMask = onRequest(async (req, res) => {
   logger.info('Got getting mask request');

   if (req.method !== 'GET') {
      logger.error('getMask: Method not allowed (expected GET)');
      res.status(405).send('Method not allowed');
      return;
   }

   try {
      const maskId = req.query.maskId;
      if (maskId === "" || maskId == null) {
         logger.error('getMask: maskId is empty');
         res.status(400).send('maskId is empty');
         return;
      }

      const maskRef = await db.collection('masks').doc(maskId.toString()).get();
      if (!maskRef.exists) {
         logger.error('getMask: Mask not found');
         res.status(404).send('Mask not found');
         return;
      }

      const maskData = maskRef.data();
      logger.info('getMask: Mask retrieved successfully');
      res.status(200).json(maskData);
   } catch (error) {
      logger.error('getMask: Error getting mask', error);
      res.status(500).json({
         success: false,
         error: 'Error getting mask: ' + error
      });
   }
});

exports.getMasks = onRequest(async (req, res) => {
   logger.info('Got getting masks request');

   if (req.method !== 'GET') {
      logger.error('getMasks: Method not allowed (expected GET)');
      res.status(405).send('Method not allowed');
      return;
   }

   try {
      let {
         limit,
         orderBy,
         orderDirection,
         lastId
      } = req.query;

      logger.info('Query params:', { limit, orderBy, orderDirection, lastId});

      limit = parseInt(limit) || 6;

      if (orderBy !== 'ratingsCount' && orderBy !== 'uploadedOn' && orderBy !== 'averageRating' && orderBy !== 'maskName') {
         orderBy = 'ratingsCount';
      }

      if (orderDirection !== 'asc' && orderDirection !== 'desc') {
         orderDirection = 'desc';
      } else {
         orderDirection = orderDirection.toLowerCase();
      }

      const masksRef = db.collection('masks');
      let masksQuery = masksRef.orderBy(orderBy, orderDirection);

      if (lastId) {
         logger.info('Starting after ID:', lastId);
         const lastDoc = await masksRef.doc(lastId).get();
         if (lastDoc.exists) {
            masksQuery = masksQuery.startAfter(lastDoc);
         }
      }

      masksQuery = masksQuery.limit(limit);

      const masksSnapshot = await masksQuery.get();
      const masks = [];
      masksSnapshot.forEach(doc => {
         masks.push(doc.data());
      });

      logger.info(`getMasks: Retrieved ${masks.length} masks`);

      const lastDoc = masksSnapshot.docs[masksSnapshot.docs.length - 1];
      const nextId = lastDoc ? lastDoc.id : null;

      res.status(200).json({
         masks: masks,
         lastId: nextId
      });
   } catch (error) {
      logger.error('getMasks: Error getting masks', error);
      res.status(500).json({
         success: false,
         error: 'Error getting masks: ' + error
      });
   }
});

exports.postRating = onRequest(async (req, res) => {
   logger.info('Got post rating request');

   if (req.method !== 'POST') {
      logger.error('postRating: Method not allowed (expected POST)');
      res.status(405).send('Method not allowed');
      return;
   }

   try {
      const {
         maskId,
         googleId,
         rating
      } = req.body;

      if (maskId === "" || maskId == null) {
         logger.error('postRating: maskId is empty');
         res.status(400).send('maskId is empty');
         return;
      }

      if (googleId === "" || googleId == null) {
         logger.error('postRating: googleId is empty');
         res.status(400).send('googleId is empty');
         return;
      }

      if (rating === "" || rating == null) {
         logger.error('postRating: rating is empty');
         res.status(400).send('rating is empty');
         return;
      }

      const maskDocId = String(maskId);

      const maskRef = await db.collection('masks').doc(maskDocId).get();
      if (!maskRef.exists) {
         logger.error('postRating: Mask not found');
         res.status(404).send('Mask not found');
         return;
      }

      const userRef = await db.collection('users').doc(googleId).get();
      if (!userRef.exists) {
         logger.error('postRating: User not found');
         res.status(404).send('User not found');
         return;
      }

      if (!userRef.data().canComment) {
         logger.error('postRating: User cannot comment');
         res.status(403).send('User is not allowed to comment');
         return;
      }

      const ratingsSnapshot = await db.collection('ratings').where('maskId', '==', maskId).where('googleId', '==', googleId).get();
      if (!ratingsSnapshot.empty) {
         const now = new Date().toISOString();

         await db.collection('ratings').doc(ratingsSnapshot.docs[0].id).update({
            rating: rating,
            postedOn: now
         });
         logger.info('postRating: Rating updated successfully');
      } else {
         const now = new Date().toISOString();
         const ratingData = {
            maskId: maskDocId,
            googleId: googleId,
            rating: rating,
            postedOn: now
         };

         await db.collection('ratings').add(ratingData);
         logger.info('postRating: Rating posted successfully');
      }

      const ratings = await db.collection('ratings').where('maskId', '==', maskDocId).get();
      let totalRating = 0;
      let ratingCount = 0;
      ratings.forEach(doc => {
         const ratingData = doc.data();
         totalRating += ratingData.rating;
         ratingCount++;
      });
      const averageRating = totalRating / ratingCount;
      await db.collection('masks').doc(maskDocId).update({
         averageRating: averageRating,
         ratingsCount: ratingCount
      });
      logger.info('postRating: Average rating updated successfully');

      res.status(200).json({
         success: true
      })
   } catch (error) {
      logger.error('postRating: Error posting rating', error);
      res.status(500).json({
         success: false,
         error: 'Error posting rating: ' + error
      });
   }
});

exports.getRating = onRequest(async (req, res) => {
   logger.info('Got getting rating request');

    if (req.method !== 'GET') {
        logger.error('getRating: Method not allowed (expected GET)');
        res.status(405).send('Method not allowed');
        return;
    }

    try {
        const maskId = req.query.maskId;
        if (maskId === "" || maskId == null) {
            logger.error('getRating: maskId is empty');
            res.status(400).send('maskId is empty');
            return;
        }

        const googleId = req.query.googleId;
        if (googleId === "" || googleId == null) {
            logger.error('getRating: googleId is empty');
            res.status(400).send('googleId is empty');
            return;
        }

        const maskDocId = String(maskId);

        const maskRef = await db.collection('masks').doc(maskDocId).get();
        if (!maskRef.exists) {
            logger.error('getRating: Mask not found');
            res.status(404).send('Mask not found');
            return;
        }

        const userRef = await db.collection('users').doc(googleId).get();
        if (!userRef.exists) {
            logger.error('getRating: User not found');
            res.status(404).send('User not found');
            return;
        }

        const ratingsSnapshot = await db.collection('ratings').where('maskId', '==', maskId).where('googleId', '==', googleId).get();
        if (ratingsSnapshot.empty) {
            logger.error('getRating: Rating not found');
            res.status(404).send('Rating not found');
            return;
        }

        const ratingData = ratingsSnapshot.docs[0].data();
        logger.info('getRating: Rating retrieved successfully');
        res.status(200).json(ratingData);
    } catch (error) {
        logger.error('getRating: Error getting rating', error);
        res.status(500).json({
            success: false,
            error: 'Error getting rating: ' + error
        });
    }
});

exports.postComment = onRequest(async (req, res) => {
   logger.info('Got post comment request');

    if (req.method !== 'POST') {
        logger.error('postComment: Method not allowed (expected POST)');
        res.status(405).send('Method not allowed');
        return;
    }

    try {
        const {
            maskId,
            googleId,
            comment
        } = req.body;

        if (maskId === "" || maskId == null) {
            logger.error('postComment: maskId is empty');
            res.status(400).send('maskId is empty');
            return;
        }

        if (googleId === "" || googleId == null) {
            logger.error('postComment: googleId is empty');
            res.status(400).send('googleId is empty');
            return;
        }

        if (comment === "" || comment == null) {
            logger.error('postComment: comment is empty');
            res.status(400).send('comment is empty');
            return;
        }

        const maskDocId = String(maskId);

        const maskRef = await db.collection('masks').doc(maskDocId).get();
        if (!maskRef.exists) {
            logger.error('postComment: Mask not found');
            res.status(404).send('Mask not found');
            return;
        }

        const userRef = await db.collection('users').doc(googleId).get();
        if (!userRef.exists) {
            logger.error('postComment: User not found');
            res.status(404).send('User not found');
            return;
        }

        if (!userRef.data().canComment) {
            logger.error('postComment: User cannot comment');
            res.status(403).send('User is not allowed to comment');
            return;
        }

       const commentSnapshot = await db.collection('comments').orderBy('id').get();
       let nextId = 0;

       commentSnapshot.forEach(doc => {
          const commentData = doc.data();
          if (commentData.id === nextId) {
             nextId++;
          }
       });

        const now = new Date().toISOString();
        const commentData = {
            id: nextId,
            maskId: maskDocId,
            googleId: googleId,
            comment: comment,
            postedOn: now
        };

        await db.collection('comments').doc(nextId.toString()).add(commentData);
        logger.info('postComment: Comment posted successfully');

        res.status(200).json({
            success: true
        });
    } catch (error) {
        logger.error('postComment: Error posting comment', error);
        res.status(500).json({
            success: false,
            error: 'Error posting comment: ' + error
        });
    }
});

exports.getComments = onRequest(async (req, res) => {
   logger.info('Got getting comments request');

    if (req.method !== 'GET') {
        logger.error('getComments: Method not allowed (expected GET)');
        res.status(405).send('Method not allowed');
        return;
    }

    try {
        const maskId = req.query.maskId;
        if (maskId === "" || maskId == null) {
            logger.error('getComments: maskId is empty');
            res.status(400).send('maskId is empty');
            return;
        }

        const maskRef = await db.collection('masks').doc(maskId).get();
        if (!maskRef.exists) {
            logger.error('getComments: Mask not found');
            res.status(404).send('Mask not found');
            return;
        }

        const commentsSnapshot = await db.collection('comments').where('maskId', '==', maskId).orderBy('postedOn', 'desc').get();
        const comments = [];
        commentsSnapshot.forEach(doc => {
            comments.push(doc.data());
        });

        logger.info('getComments: Comments retrieved successfully');
        res.status(200).json(comments);
    } catch (error) {
        logger.error('getComments: Error getting comments', error);
        res.status(500).json({
            success: false,
            error: 'Error getting comments: ' + error
        });
    }
});

exports.postReport = onRequest(async (req, res) => {
   logger.info('Got post report request');

    if (req.method !== 'POST') {
        logger.error('postReport: Method not allowed (expected POST)');
        res.status(405).send('Method not allowed');
        return;
    }

    try {
       const {
          reportedItemType,
          reportedItemId,
          reporterGoogleId,
          reason,
          description
       } = req.body;

       if (reportedItemType === "" || reportedItemType == null) {
          logger.error('postReport: reportedItemType is empty');
          res.status(400).send('reportedItemType is empty');
          return;
       }

       if (reportedItemId === "" || reportedItemId == null) {
          logger.error('postReport: reportedItemId is empty');
          res.status(400).send('reportedItemId is empty');
          return;
       }

       if (reporterGoogleId === "" || reporterGoogleId == null) {
          logger.error('postReport: reporterGoogleId is empty');
          res.status(400).send('reporterGoogleId is empty');
          return;
       }

       if (reason === "" || reason == null) {
          logger.error('postReport: reason is empty');
          res.status(400).send('reason is empty');
          return;
       }

       const now = new Date().toISOString();

       const reportData = {
          reportedItemType: reportedItemType,
          reportedItemId: reportedItemId,
          reporterGoogleId: reporterGoogleId,
          reason: reason,
          description: description || '',
          reportedOn: now
       };

       await db.collection('reports').add(reportData);
       logger.info('postReport: Report posted successfully');

       res.status(200).json({
          success: true
       });
    } catch (error) {
        logger.error('postReport: Error posting report', error);
        res.status(500).json({
            success: false,
            error: 'Error posting report: ' + error
        });
    }
});