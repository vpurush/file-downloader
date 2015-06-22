var fs = require('fs');
var http = require('http');
var url = require('url');
var path = require('path');
var messageQueue = require('./message-queue');
var Promise = require('promise');
var partDownloadSize = 1024 * 500; //500KB
var multiplePartDownloadLimit = 5;

var urlParam = process.argv[2];
if (!urlParam || urlParam.length == 0) {
    console.log('Please pass url in the parameter');
    process.exit();
}
makeHEADRequest(urlParam, 'HEAD');

function parseUrl(urlString){
    var urlObj = url.parse(urlString, true, false);

    if(!urlObj.host){
        console.log("invlaid url");
        process.exit();
    }
    //console.log('urlObj', urlObj);
    return urlObj;
}

function makeHEADRequest(urlString){
    var urlObj = parseUrl(urlString);

    var requestOptions = {
        hostname: urlObj.host,
        path: urlObj.path,
        method: 'HEAD'
    };
    console.log("requestOptions", requestOptions);

    var req = http.request(requestOptions, function(res){
        //console.log("response headers", res.headers, res);

        if(res.headers.location && res.headers.location.length > 0){
            console.log("Location header found. Following..");
            console.log("\n\n\n");
            makeHEADRequest(res.headers.location);
        } else {
            var acceptRangesHeader = res.headers['accept-ranges'];
            if (acceptRangesHeader && acceptRangesHeader.length > 0 && acceptRangesHeader == 'bytes') {
                console.log('accept-ranges header found. Attempting download');
                var contentLength = res.headers['content-length'];
                populateDownloadQueue(urlString, contentLength);
            }else{
                console.log('Either accept-ranges header is not present or its values is not bytes. Exitting..');
                process.exit();
            }
        }
    });

    req.on('error', function(e) {
        console.log('problem with request: ' + e.message);
        process.exit();
    });

    console.log("\n\n\nMaking head request:", urlString);
    req.end();
}

function populateDownloadQueue(urlString, contentLength) {
    console.log(urlString, contentLength);
    var urlObj = url.parse(urlString, true, false);
    var moreToDownload = contentLength;
    var fileName = path.basename(decodeURI(urlObj.pathname));
    var pathForPartFiles = './' + fileName + '/';
    var downloadMessageQueue = new messageQueue();
    fs.mkdir(pathForPartFiles, function (err) {
        if (err) {
            if (err.code == 'EEXIST') {
                console.log("Folder already exists. Exitting");
            } else {
                console.log("err", err);
            }            
            process.exit();
        }
        var startByte = 0;
        var endByte = -1;
        for (var i = 0; moreToDownload > 0 ; i++) {
            console.log("inside loop", i);
            startByte = endByte + 1;
            if (partDownloadSize < moreToDownload) {
                endByte = endByte + partDownloadSize;
                moreToDownload = moreToDownload - partDownloadSize;
            } else {
                endByte = endByte + moreToDownload;
                moreToDownload = 0;
            }

            var partFile = fs.createWriteStream(pathForPartFiles + fileName + '.' + i + '.part');
            partFile.on('error', function (e) {
                console.log("error occured while opening the file", e);
            });

            var messageData = {
                urlObj: urlObj,
                startByte: startByte,
                endByte: endByte,
                partFile: partFile,
                index: i
            };
            downloadMessageQueue.AddMessage(messageData);
        }
        console.log("download queue length", downloadMessageQueue.GetLength);
        startDownload(downloadMessageQueue, multiplePartDownloadLimit).then(function () {
            console.log("download completed");
            combinePartFiles(pathForPartFiles, fileName, 0, null);
        }, function (e) {
            console.log("Failed ", e);
        });
    });
}

function startDownload(queue, count) {    
    var promiseArray = [];
    for (var i = 0; i < count; i++) {
        var downloadPromise = new Promise(function(resolve, reject){
            var message = queue.GetMessage();

            if (message) {
                var messageData = message.Data;
                var p = downloadFilePart(messageData.urlObj, messageData.startByte, messageData.endByte, messageData.partFile);
                p.then(function () {
                    message.Remove();
                    startDownload(queue, 1).then(function () {
                        resolve();
                    }, function (e) {
                        reject(e);
                    });
                }, function (e) {
                    reject(e);
                    console.log("error occurred. retry logic not written.", e);
                });
            } else {
                resolve();
            }
        })
        promiseArray.push(downloadPromise);
    }
    return Promise.all(promiseArray);
}

function downloadFilePart(urlObj, startByte, endByte, partFile) {
    var p = new Promise(function (resolve, reject) {
        var requestOptions = {
            hostname: urlObj.host,
            path: urlObj.path,
            method: 'GET',
            headers: {
                'Range': 'bytes=' + startByte + '-' + endByte
            }
        };
        //console.log("requestOptions", requestOptions);

        var req = http.request(requestOptions, function (res) {
            //console.log("response headers", res.headers, res);

            if (res.headers.location && res.headers.location.length > 0) {
                console.log("Location header found. Not handled. Quitting..");
                console.log("\n\n\n");
                process.exit();
            } else {
                res.pipe(partFile);
            }

            res.on('end', function () {
                console.log("end response");
                resolve();
            });

            res.on('close', function () {
                console.log("close response");
                resolve();
            });

            res.on('error', function (e) {
                reject();
            });
        });

        req.on('error', function (e) {
            console.log('problem with request: ' + e.message);
            reject(e);
            //process.exit();
        });

        console.log("\n\n\nMaking download request:", urlObj.href, startByte, endByte);
        req.end();
    });
    return p;
}

function combinePartFiles(path, filename, startIndex, writeStream) {
    if(!writeStream){
        writeStream = fs.createWriteStream(path + filename);
    }
    var p = new Promise(function (resolve, reject) {
        var readStream = fs.createReadStream(path + filename + '.' + startIndex + '.part');
        readStream.pipe(writeStream, { end: false });
        readStream.on('end', function () {
            combinePartFiles(path, filename, startIndex + 1, writeStream).then(function () {
                resolve();
                fs.unlink(path + filename + '.' + startIndex + '.part');
            }, function (e) {
                reject(e);
            });
        });

        readStream.on('error', function (e) {
            if (e.code == 'ENOENT') {
                resolve();
            } else {
                console.log("error occurred", e);
            }
        });
    });

    if (startIndex == 0) {
        p.then(function () {
            writeStream.end();
        });
    }
    return p;
}