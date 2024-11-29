const functions = require('firebase-functions');

exports.test = functions.https.onRequest((req, res) => {
    res.send('Hello from Firebase!');
});