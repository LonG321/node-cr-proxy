'use strict';

const fs = require('fs');
const zlib = require('zlib');

var ByteBuffer = require("../util/bytebuffer-sc");
var EMsg = require('../enums/emsg');

class Definitions {

    constructor(options) {
        var self = this;

        self.definitions = [];
        self.components = [];
        self.options = options;

        ['client', 'server', 'component'].forEach(function(folder) {
            fs.readdir('./node_modules/cr-messages/' + folder, (err, files) => {
                console.time('Loaded ' + folder + ' definitions in');
                if (err) {
                    console.log('error opening node-modules/cr-messages/' + folder + ': ' + err);
                    process.exit(1);
                }

                files.forEach(file => {
                    if(self.options.verbose) {
                        console.log('loading ' + folder +'/' + file +'...');
                    }

                    var json = JSON.parse(fs.readFileSync('./node_modules/cr-messages/' + folder + '/' + file, 'utf8'));

                    if (json.id) {
                        self.definitions[json.id] = json;
                    } else {
                        self.components[json.name] = json;

                        if (json.extensions) {
                            var extensions = [];

                            for (var key in json.extensions) {
                                extensions[json.extensions[key].id] = json.extensions[key];
                            }

                            self.components[json.name].extensions = extensions;
                        }
                    }
                });

                console.timeEnd('Loaded ' + folder + ' definitions in');
            });
        });
    }

    decode_fields(reader, fields) {
        var unknown = 0;
        var decoded = {};

        fields.forEach((field, index) => {
            var fieldType = field.type.substring(0); // creates a clone without reference

            if (!field.name) {
                field.name = "unknown_" + index;
            }

            if (fieldType.includes('[')) {
                var n = fieldType.substring(fieldType.indexOf('[') + 1, fieldType.indexOf(']'));
                fieldType = fieldType.substring(0, fieldType.indexOf('['));

                // if n is specified, then we use it, otherwise we need to read how big the array is
                // may need to implement lenghtType, but seems unecessary, they are all RRSINT32 afaik
                if (n === '') {
                    n = reader.readRrsInt32();
                } else {
                    n = parseInt(n);
                }

                decoded[field.name] = [];

                for (var i = 0; i < n; i++) {
                    decoded[field.name][i] = this.decode_field(reader, fieldType, field);
                }
            } else {
                decoded[field.name] = this.decode_field(reader, fieldType, field);
            }
        });

        return decoded;
    }

    decode_field(reader, fieldType, field) {
        var decoded;

        if (fieldType.includes('?')) {
            var bool = reader.readByte();

            if (bool == 1) {
                fieldType = fieldType.substring(1);
            } else {
                reader.offset--; // we only peeked, multiple bools can be mixed together
                return false;
            }
        }

        if (fieldType == 'BYTE') {
            decoded = reader.readByte();
        } else if (fieldType == 'SHORT') {
            decoded = reader.readInt16();
        } else if (fieldType == 'INT') {
            decoded = reader.readInt32();
        } else if (fieldType == 'INT32') {
            decoded = reader.readVarint32();
        } else if (fieldType == 'RRSINT32') {
            decoded = reader.readRrsInt32();
        } else if (fieldType == 'LONG') {
            decoded = reader.readInt64();
        } else if (fieldType == 'STRING') {
            decoded = reader.readIString();
        } else if (fieldType == 'ZIP_STRING') {
            var len = reader.readInt32() - 4; // it's prefixed with a INT32 of the unzipped length

            reader.LE(); // switch to little endian
            var zlength = reader.readInt32();
            reader.BE(); // switch back to big endian

            if(reader.remaining() >= len) {
                decoded = zlib.unzipSync(reader.slice(reader.offset, reader.offset + len).toBuffer()).toString();
                reader.offset = reader.offset + len;
            } else {
                decoded = false;
                console.log('Insufficient data to unzip field.');
            }
        } else if (fieldType == 'IGNORE') {
            decoded = reader.remaining() + ' bytes have been ignored.';
            reader.offset = reader.limit;
        } else if (this.components[fieldType]) {
            decoded = this.decode_fields(reader, this.components[fieldType].fields);
            if (this.components[fieldType].extensions !== undefined) {

                if (decoded.id !== undefined) {
                    var extensionDef = this.components[fieldType].extensions.find(function(extension) {
                        if (extension) {
                            return extension.id == decoded.id;
                        } else {
                            return 0;
                        }
                    });

                    if (extensionDef) {
                        decoded.payload = this.decode_fields(reader, extensionDef.fields);
                    } else {
                        console.warn('Error: Extensions of field type ' + fieldType + ' with id ' + decoded.id + ' is missing. (' + field.name + ').');
                        return false;
                    }
                } else {
                    console.warn('Warning: missing id for component ' + fieldType + ' (' + field.name + ').');
                    return false;
                }
            }
        } else {
            console.error('Error: field type ' + fieldType + ' does not exist. (' + field.name + '). Exiting.');
            process.exit(1);
        }

        return decoded;
    }

    decode(message) {
        var reader = ByteBuffer.fromBinary(message.decrypted);

        if (this.definitions[message.messageType]) {
            message.decoded = {};

            if (this.definitions[message.messageType].fields && this.definitions[message.messageType].fields.length) {
                message.decoded = this.decode_fields(reader, this.definitions[message.messageType].fields);
            }

            if (reader.remaining() && this.options.verbose) {
                console.warn(reader.remaining() + ' bytes remaining...');
                reader.printDebug();
            }
        } else {
            console.warn('Missing definition for ' + (EMsg[message.messageType] ? EMsg[message.messageType] : message.messageType));
            if(this.options.verbose) {
                reader.printDebug();
            }
        }
    }
}

module.exports = Definitions;
