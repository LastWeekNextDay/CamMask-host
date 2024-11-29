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

initializeApp();
const db = getFirestore();

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
