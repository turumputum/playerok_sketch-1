#!/usr/bin/env node

/* jshint esversion: 6 */
/* jshint node: true */
"use strict";

const helperFuncs = require('./assets/helperFuncs');

const express = require("express");
const { engine: hbs } = require("express-handlebars");
const session = require("express-session");
const busboy = require("connect-busboy");
const flash = require("connect-flash");
const querystring = require("querystring");
const assets = require("./assets");
const archiver = require("archiver");

const notp = require("notp");
const base32 = require("thirty-two");

const fs = require("fs");
const rimraf = require("rimraf");
const path = require("path");

const filesize = require("filesize");
const octicons = require("@primer/octicons");
const handlebars = require("handlebars");

const mqtt = require("mqtt");
const client  = mqtt.connect('mqtt://127.0.0.1:1883')

var os = require('os');

var currentPage = "home";
var configAndStatus = "";

const port = +process.env.PORT || 3000;

const app = express();
const http = app.listen(port);

app.set("views", path.join(__dirname, "views"));
app.use('/css', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/css')))
app.use('/js', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/js'))) 
app.use('/jquery', express.static(path.join(__dirname, 'node_modules/jquery/dist'))) 
app.use('/bootstrap-icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons'))) 
app.use('/glyphicons', express.static(path.join(__dirname, 'node_modules/glyphicons'))) 
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use("/icons", express.static(path.join(__dirname, "views/icons")));
app.set('view engine', 'pug')
 
//----------------MQTT------------------------------
client.on('connect', function () {
  console.log("mqtt brocker connected!");
  client.subscribe('presence', function (err) {
    if (!err) {
      client.publish('presence', 'Hello mqtt')
    }
  })
})

client.on('message', function (topic, message) {
  // message is Buffer
  console.log(message.toString())
})

//----------------MQTT------------------------------



//----------------CONFIG------------------------------
function readConfigAndStatus(){
  let rawdata = fs.readFileSync('configAndstatus.json');
  configAndStatus = JSON.parse(rawdata);
  console.log("configAndStatus read ok");
}

readConfigAndStatus();

//----------------CONFIG------------------------------

app.use(
  session({
    secret: process.env.SESSION_KEY || "meowmeow",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(flash());
app.use(busboy());
app.use(
  express.urlencoded({
    extended: false,
  })
);


function relative(...paths) {
  
  var finalPath = paths.reduce((a, b) => path.join(a, b), process.cwd());
   
  if (path.relative(process.cwd(), finalPath).startsWith("..")) {
    throw new Error("Failed to resolve path outside of the working directory");
  }
  return finalPath;
}
function flashify(req, obj) {
  let error = req.flash("error");
  if (error && error.length > 0) {
    if (!obj.errors) {
      obj.errors = [];
    }
    obj.errors.push(error);
  }
  let success = req.flash("success");
  if (success && success.length > 0) {
    if (!obj.successes) {
      obj.successes = [];
    }
    obj.successes.push(success);
  }
  obj.isloginenabled = 0;
  return obj;
}

app.use((req, res, next) => {
  if (req.method === "GET") {
    return next();
  }
  let sourceHost = null;
  if (req.headers.origin) {
    sourceHost = new URL(req.headers.origin).host;
  } else if (req.headers.referer) {
    sourceHost = new URL(req.headers.referer).host;
  }
  if (sourceHost !== req.headers.host) {
    throw new Error(
      "Origin or Referer header does not match or is missing. Request has been blocked to prevent CSRF"
    );
  }
  next();
});

app.all("/*", (req, res, next) => {
  res.filename = req.params[0];

  let fileExists = new Promise((resolve, reject) => {
    // check if file exists
    fs.stat(relative(res.filename), (err, stats) => {
      if (err) {
        return reject(err);
      }
      return resolve(stats);
    });
  });

  fileExists
    .then((stats) => {
      res.stats = stats;
      next();
    })
    .catch((err) => {
      res.stats = { error: err };
      next();
    });
});

app.post("/*@upload", (req, res) => {
  res.filename = req.params[0];

  let buff = null;
  let saveas = null;
  req.busboy.on("file", (key, stream, filename) => {
    if (key == "file") {
      let buffs = [];
      stream.on("data", (d) => {
        buffs.push(d);
      });
      stream.on("end", () => {
        buff = Buffer.concat(buffs);
        buffs = null;
      });
    }
  });
  req.busboy.on("field", (key, value) => {
    if (key == "saveas") {
      saveas = value;
    }
  });
  req.busboy.on("finish", () => {
    if (!buff || !saveas) {
      return res.status(400).end();
    }
    let fileExists = new Promise((resolve, reject) => {
      // check if file exists
      fs.stat(relative(res.filename, saveas), (err, stats) => {
        if (err) {
          return reject(err);
        }
        return resolve(stats);
      });
    });

    fileExists
      .then((stats) => {
        console.warn("file exists, cannot overwrite");
        req.flash("error", "File exists, cannot overwrite. ");
        res.redirect("back");
      })
      .catch((err) => {
        const saveName = relative(res.filename, saveas);
        console.log("saving file to " + saveName);
        let save = fs.createWriteStream(saveName);
        save.on("close", () => {
          if (res.headersSent) {
            return;
          }
          if (buff.length === 0) {
            req.flash("success", "File saved. Warning: empty file.");
          } else {
            buff = null;
            req.flash("success", "File saved. ");
          }
          res.redirect("back");
        });
        save.on("error", (err) => {
          console.warn(err);
          req.flash("error", err.toString());
          res.redirect("back");
        });
        save.write(buff);
        save.end();
      });
  });
  req.pipe(req.busboy);
});

app.post("/*@mkdir", (req, res) => {
  res.filename = req.params[0];

  let folder = req.body.folder;
  if (!folder || folder.length < 1) {
    return res.status(400).end();
  }

  let fileExists = new Promise((resolve, reject) => {
    // Check if file exists
    fs.stat(relative(res.filename, folder), (err, stats) => {
      if (err) {
        return reject(err);
      }
      return resolve(stats);
    });
  });

  fileExists
    .then((stats) => {
      req.flash("error", "Folder exists, cannot overwrite. ");
      res.redirect("back");
    })
    .catch((err) => {
      fs.mkdir(relative(res.filename, folder), (err) => {
        if (err) {
          console.warn(err);
          req.flash("error", err.toString());
          res.redirect("back");
          return;
        }
        req.flash("success", "Folder created. ");
        res.redirect("back");
      });
    });
});

app.post("/*@delete", (req, res) => {
  res.filename = req.params[0];

  let files = JSON.parse(req.body.files);
  if (!files || !files.map) {
    req.flash("error", "No files selected.");
    res.redirect("back");
    return; // res.status(400).end();
  }

  let promises = files.map((f) => {
    return new Promise((resolve, reject) => {
      fs.stat(relative(res.filename, f), (err, stats) => {
        if (err) {
          return reject(err);
        }
        resolve({
          name: f,
          isdirectory: stats.isDirectory(),
          isfile: stats.isFile(),
        });
      });
    });
  });
  Promise.all(promises)
    .then((files) => {
      let promises = files.map((f) => {
        return new Promise((resolve, reject) => {
          let op = null;
          if (f.isdirectory) {
            op = (dir, cb) =>
              rimraf(
                dir,
                {
                  glob: false,
                },
                cb
              );
          } else if (f.isfile) {
            op = fs.unlink;
          }
          if (op) {
            op(relative(res.filename, f.name), (err) => {
              if (err) {
                return reject(err);
              }
              resolve();
            });
          }
        });
      });
      Promise.all(promises)
        .then(() => {
          req.flash("success", "Files deleted. ");
          res.redirect("back");
        })
        .catch((err) => {
          console.warn(err);
          req.flash("error", "Unable to delete some files: " + err);
          res.redirect("back");
        });
    })
    .catch((err) => {
      console.warn(err);
      req.flash("error", err.toString());
      res.redirect("back");
    });
});

app.get("/*@download", (req, res) => {
  res.filename = req.params[0];

  let files = null;
  try {
    files = JSON.parse(req.query.files);
  } catch (e) {}
  if (!files || !files.map) {
    req.flash("error", "No files selected.");
    res.redirect("back");
    return; // res.status(400).end();
  }

  let promises = files.map((f) => {
    return new Promise((resolve, reject) => {
      fs.stat(relative(res.filename, f), (err, stats) => {
        if (err) {
          return reject(err);
        }
        resolve({
          name: f,
          isdirectory: stats.isDirectory(),
          isfile: stats.isFile(),
        });
      });
    });
  });
  Promise.all(promises)
    .then((files) => {
      let zip = archiver("zip", {});
      zip.on("error", function (err) {
        console.warn(err);
        res.status(500).send({
          error: err.message,
        });
      });

      files
        .filter((f) => f.isfile)
        .forEach((f) => {
          zip.file(relative(res.filename, f.name), { name: f.name });
        });
      files
        .filter((f) => f.isdirectory)
        .forEach((f) => {
          zip.directory(relative(res.filename, f.name), f.name);
        });

      res.attachment("Archive.zip");
      zip.pipe(res);

      zip.finalize();
    })
    .catch((err) => {
      console.warn(err);
      req.flash("error", err.toString());
      res.redirect("back");
    });
});

app.post("/*@rename", (req, res) => {
  res.filename = req.params[0];

  let files = JSON.parse(req.body.files);
  if (!files || !files.map) {
    req.flash("error", "No files selected.");
    res.redirect("back");
    return;
  }

  new Promise((resolve, reject) => {
    fs.access(relative(res.filename), fs.constants.W_OK, (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  })
    .then(() => {
      let promises = files.map((f) => {
        return new Promise((resolve, reject) => {
          fs.rename(
            relative(res.filename, f.original),
            relative(res.filename, f.new),
            (err) => {
              if (err) {
                return reject(err);
              }
              resolve();
            }
          );
        });
      });
      Promise.all(promises)
        .then(() => {
          req.flash("success", "Files renamed. ");
          res.redirect("back");
        })
        .catch((err) => {
          console.warn(err);
          req.flash("error", "Unable to rename some files: " + err);
          res.redirect("back");
        });
    })
    .catch((err) => {
      console.warn(err);
      req.flash("error", err.toString());
      res.redirect("back");
    });
});

const shellable = process.env.SHELL != "false" && process.env.SHELL;
const cmdable = process.env.CMD != "false" && process.env.CMD;
if (shellable || cmdable) {
  const shellArgs = process.env.SHELL.split(" ");
  const exec = process.env.SHELL == "login" ? "/usr/bin/env" : shellArgs[0];
  const args = process.env.SHELL == "login" ? ["login"] : shellArgs.slice(1);

  const child_process = require("child_process");

  app.post("/*@cmd", (req, res) => {
    res.filename = req.params[0];

    let cmd = req.body.cmd;
    if (!cmd || cmd.length < 1) {
      return res.status(400).end();
    }
    console.log("running command " + cmd);

    child_process.exec(
      cmd,
      {
        cwd: relative(res.filename),
        timeout: 60 * 1000,
      },
      (err, stdout, stderr) => {
        if (err) {
          console.log("command run failed: " + JSON.stringify(err));
          req.flash("error", "Command failed due to non-zero exit code");
        }
        res.render(
          "cmd",
          flashify(req, {
            path: res.filename,
            cmd: cmd,
            stdout: stdout,
            stderr: stderr,
          })
        );
      }
    );
  });

  const pty = require("node-pty");
  const WebSocket = require("ws");

  app.get("/*@shell", (req, res) => {
    res.filename = req.params[0];

    res.render(
      "shell",
      flashify(req, {
        path: res.filename,
      })
    );
  });

  const ws = new WebSocket.Server({ server: http });
  ws.on("connection", (socket, request) => {
    const { path } = querystring.parse(request.url.split("?")[1]);
    let cwd = relative(path);
    let term = pty.spawn(exec, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 30,
      cwd: cwd,
    });
    console.log(
      "pid " + term.pid + " shell " + process.env.SHELL + " started in " + cwd
    );

    term.on("data", (data) => {
      socket.send(data, { binary: true });
    });
    term.on("exit", (code) => {
      console.log("pid " + term.pid + " ended");
      socket.close();
    });
    socket.on("message", (data) => {
      // special messages should decode to Buffers
      if (data.length == 6) {
        switch (data.readUInt16BE(0)) {
          case 0:
            term.resize(data.readUInt16BE(1), data.readUInt16BE(2));
            return;
        }
      }
      term.write(data);
    });
    socket.on("close", () => {
      term.end();
    });
  });
}

const SMALL_IMAGE_MAX_SIZE = 5750 * 1024; // 5750 KB
const EXT_IMAGES = [".jpg", ".jpeg", ".png", ".webp", ".svg", ".gif", ".tiff"];
function isimage(f) {
  for (const ext of EXT_IMAGES) {
    if (f.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

app.get("/", (req, res) => {
  //console.log('curent page is:' + configAndStatus.net.DHCP);
  res.render("home",{
    pageName: "home",
    configAndStatus: configAndStatus
  });
});

app.get("/main", (req, res) => {
  //console.log('curent page is:' + configAndStatus.net.DHCP);
  res.render("main",{
    pageName: "main",
    configAndStatus: configAndStatus
  });
});

app.get("/data*", (req, res) => {
  if (res.stats.error) {
    res.render(
      "list",
      flashify(req, {
        shellable: shellable,
        cmdable: cmdable,
        path: res.filename,
        errors: [res.stats.error],
      })
    );
    console.log('status error'+res);
  } else if (res.stats.isDirectory()) {
    if (!req.url.endsWith("/")) {
      return res.redirect(req.url + "/");
    }

    let readDir = new Promise((resolve, reject) => {
      fs.readdir(relative(res.filename), (err, filenames) => {
        if (err) {
          return reject(err);
        }
        //console.log(filenames);
        return resolve(filenames);
      });
    });

    readDir
      .then((filenames) => {
        const promises = filenames.map(
          (f) =>
            new Promise((resolve, reject) => {
              fs.stat(relative(res.filename, f), (err, stats) => {
                if (err) {
                  console.warn(err);
                  return resolve({
                    name: f,
                    error: err,
                  });
                }
                resolve({
                  name: f,
                  isdirectory: stats.isDirectory(),
                  issmallimage: isimage(f) && stats.size < SMALL_IMAGE_MAX_SIZE,
                  size: stats.size,
                });
              });
            })
        );

        Promise.all(promises)
          .then((files) => {
            files.sort(function(a, b) {
              if (a.isdirectory != b.isdirectory) {        // Is one a folder and
                 return (a.isdirectory ? -1 : 1);       //  the other a file?
              }                                      // If not, compare the
              return a.name.localeCompare(b.name);   //  the names.
            });
            res.render(
              "list",
              flashify(req, {
                shellable: shellable,
                cmdable: cmdable,
                path: res.filename,
                files: files,
                pageName: "FileManager",
                dirs: res.filename.split('/'),
              })
            );
            //console.log('render list')
          })
          .catch((err) => {
            console.error(err);
            res.render(
              "list",
              flashify(req, {
                shellable: shellable,
                cmdable: cmdable,
                path: res.filename,
                errors: [err],
              })
            );
          });
      })
      .catch((err) => {
        console.warn(err);
        res.render(
          "list",
          flashify(req, {
            shellable: shellable,
            cmdable: cmdable,
            path: res.filename,
            errors: [err],
          })
        );
      });
  } else if (res.stats.isFile()) {
    res.sendFile(relative(res.filename), {
      headers: {
        "Content-Security-Policy":
          "default-src 'self'; script-src 'none'; sandbox",
      },
      dotfiles: "allow",
    });
  }
});

console.log(`Listening on port ${port}`);

console.log(os.cpus());
console.log(os.totalmem());
console.log(os.freemem())
