const functions = require('firebase-functions');
const express = require('express');

const app = express();
const port = process.env.PORT || 8080;

exports.test = functions.https.onRequest((req, res) => {
    res.send('Hello from Firebase!');
});

app.listen(port, () => {
    console.log(`Running on port ${port}.`);
});

