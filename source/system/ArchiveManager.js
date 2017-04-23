"use strict";

const stringHash = require("string-hash");
const Queue = require("promise-queue");
const credentialsToSources = require("./archiveManagement/marshalling.js").credentialsToSources;

const STORAGE_KEY_PREFIX = "bcup_archivemgr_";
const STORAGE_KEY_COLLECTION = "bcup_archivemgr__keys_";
const STORAGE_QUEUE_CONCURRENCY = 1;
const STORAGE_QUEUE_LIMIT = Infinity;

function encodeStorageName(name) {
    return stringHash(name).toString();
}

class ArchiveManager {
    
    constructor(storageInterface) {
        this._storageInterface = storageInterface;
        this._sources = {};
        this._storageQueue = new Queue(STORAGE_QUEUE_CONCURRENCY, STORAGE_QUEUE_LIMIT);
    }

    get sources() {
        return this._sources;
    }

    get storageInterface() {
        return this._storageInterface;
    }

    get storageQueue() {
        return this._storageQueue;
    }

    get unlockedSources() {
        return Object.keys(this._sources)
            .map(key => this._sources[key])
            .filter(source => source.status === ArchiveManager.ArchiveStatus.UNLOCKED);
    }

    addSource(name, sourceCredentials, archiveCredentials, initialise = false) {
        return credentialsToSources(sourceCredentials, archiveCredentials, initialise)
            .then(sourcesInfo => {
                sourcesInfo.forEach(sourceInfo => {
                    if (this.sources.hasOwnProperty(sourceInfo.name) && !this.sources[sourceInfo.name].unlock) {
                        throw new Error(`Cannot add source: Archive source with this name already exists: ${sourceInfo.name}`);
                    }
                });
                sourcesInfo.forEach(sourceInfo => {
                    this._sources[name] = Object.assign(
                        {
                            status: ArchiveManager.ArchiveStatus.UNLOCKED,
                            type: sourceCredentials.type
                        },
                        sourceInfo
                    );
                    return this.dehydrate();
                });
            });
    }

    dehydrate() {
        return this.storageQueue.add(() => 
            Promise
                .all(this.unlockedSources.map(source => {
                    const archiveCredentials = source.archiveCredentials;
                    return Promise
                        .all([
                            source.parentSourceCredentials.toSecureString(archiveCredentials.password),
                            archiveCredentials.toSecureString(archiveCredentials.password)
                        ])
                        .then(([encParentCreds, encArchiveCreds] = []) => {
                            console.log("WRITING SOURCE", Object.assign({}, source), source.name);
                            const packet = {
                                name: source.name,
                                sourceCredentials: encParentCreds,
                                archiveCredentials: encArchiveCreds,
                                type: source.type
                            };
                            const key = `${STORAGE_KEY_PREFIX}${encodeStorageName(source.type + source.name)}`;
                            return this.storageInterface
                                .setValue(key, JSON.stringify(packet))
                                .then(() => key);
                        });
                }))
                .then(keys => {
                    return this.storageInterface.setValue(
                        STORAGE_KEY_COLLECTION,
                        keys.join(",")
                    );
                })
        );
    }

    lock(name) {
        if (this.sources.hasOwnProperty(name) !== true) {
            throw new Error(`Failed to lock: Source not found: ${name}`);
        }
        const source = this.sources[name];
        if (source.status !== ArchiveManager.ArchiveStatus.UNLOCKED) {
            throw new Error(`Failed to lock: Source state invalid: ${source.status}`);
        }
        const originalStatus = source.status;
        source.status = ArchiveManager.ArchiveStatus.PROCESSING;
        console.log("Locking", name);
        return this
            .dehydrate()
            .then(() => this.storageQueue.add(() =>
                Promise.all([
                    source.parentSourceCredentials.toSecureString(source.archiveCredentials.password),
                    source.archiveCredentials.toSecureString(source.archiveCredentials.password)
                ])
            ))
            .then(
                ([encParentCreds, encArchiveCreds] = []) => {
                    console.log("Locked", name);
                    this.sources[name] = {
                        name: source.name,
                        type: source.type,
                        status: ArchiveManager.ArchiveStatus.LOCKED,
                        sourceCredentials: encParentCreds,
                        archiveCredentials: encArchiveCreds
                    };
                },
                function _handleDehydrateError(error) {
                    // restore original status
                    source.status = originalStatus;
                    throw error;
                }
            );
    }

    rehydrate() {
        this._sources = {};
        return this.storageQueue.add(() =>
            this.storageInterface
                .getValue(STORAGE_KEY_COLLECTION)
                .then(keys => Promise.all(
                    keys.split(",").map(key => this.storageInterface.getValue(key))
                ))
                .then(packets => {
                    packets.forEach(packetRaw => {
                        const packet = JSON.parse(packetRaw);
                        this._sources[packet.name] = {
                            name: packet.name,
                            type: packet.type,
                            status: ArchiveManager.ArchiveStatus.LOCKED,
                            sourceCredentials: packet.sourceCredentials,
                            archiveCredentials: packet.archiveCredentials
                        };
                    })
                })
        );
    }

    unlock(name, masterPassword) {
        if (this.sources.hasOwnProperty(name) !== true) {
            throw new Error(`Failed to unlock: Source not found: ${name}`);
        }
        const source = this.sources[name];
        const originalStatus = source.status;
        source.status = ArchiveManager.ArchiveStatus.PROCESSING;
        source.unlock = true;
        return this.storageQueue.add(() =>
            this
                .addSource(
                    name,
                    source.sourceCredentials,
                    source.archiveCredentials
                )
        );
    }

}

ArchiveManager.ArchiveStatus = Object.freeze({
    UNLOCKED:       "unlocked",
    LOCKED:         "locked",
    PROCESSING:     "processing"
});

module.exports = ArchiveManager;
