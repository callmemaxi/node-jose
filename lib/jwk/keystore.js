/*!
 * jwk/keystore.js - JWK KeyStore Implementation
 *
 * Copyright (c) 2015 Cisco Systems, Inc. See LICENSE file.
 */
"use strict";

var clone = require("lodash.clone"),
    merge = require("../util/merge");

var JWK = {
  BaseKey: require("./basekey.js")
};

/**
 * @class JWK.KeyStoreRegistry
 * @classdesc
 * A registry of JWK.Key types that can be used.
 *
 * @description
 * **NOTE:** This constructor cannot be called directly. Instead use the
 * global {JWK.registry}
 */
var JWKRegistry = function() {
  var types = {};

  Object.defineProperty(this, "register", {
    value: function(factory) {
      if (!factory || "string" !== typeof factory.kty || !factory.kty) {
        throw new Error("invalid Key factory");
      }

      var kty = factory.kty;
      types[kty] = factory;
      return this;
    }
  });
  Object.defineProperty(this, "unregister", {
    value: function(factory) {
      if (!factory || "string" !== typeof factory.kty || !factory.kty) {
        throw new Error("invalid Key factory");
      }

      var kty = factory.kty;
      if (factory === types[kty]) {
        delete types[kty];
      }
      return this;
    }
  });

  Object.defineProperty(this, "get", {
    value: function(kty) {
      return types[kty || ""] || undefined;
    }
  });
};

// Globals
var GLOBAL_REGISTRY = new JWKRegistry();

/**
 * @class JWK.KeyStore
 * @classdesc
 * Represents a collection of Keys.
 *
 * @description
 * **NOTE:** This constructor cannot be called directly. Instead call {@link
 * JWK.createKeyStore}.
 */
var JWKStore = function(registry, parent) {
  var keysets = {};

  /**
   * @method JWK.KeyStore#generate
   * @description
   * Generates a new random Key into this KeyStore.
   *
   * The type of {size} depends on the value of {kty}:
   *
   * + **`EC`**: String naming the curve to use, which can be one of:
   *   `"P-256"`, `"P-384"`, or `"P-521"` (default is **`"P-256"`**).
   * + **`RSA`**: Number describing the size of the key, in bits (default is
   *   **`2048`**).
   * + **`oct`**: Number describing the size of the key, in bits (default is
   *   **`256`**).
   *
   * Any properties in {props} are applied before the key is generated,
   * and are expected to be data types acceptable in JSON.  This allows the
   * generated key to have a specific key identifier, or to specify its
   * acceptable usage.
   *
   * The returned Promise, when fulfilled, returns the generated Key.
   *
   * @param {String} kty The type of generated key
   * @param {String|Number} [size] The size of the generated key
   * @param {Object} [props] Additional properties to apply to the generated
   *        key.
   * @returns {Promise} The promise for the generated Key
   * @throws {Error} If {kty} is not supported
   */
  Object.defineProperty(this, "generate", {
    value: function(kty, size, props) {
      var keytype = registry.get(kty);
      if (!keytype) {
        return Promise.reject(new Error("unsupported key type"));
      }

      props = clone(props || {});
      props.kty = kty;

      var self = this,
          promise = keytype.generate(size);
      return promise.then(function(jwk) {
        jwk = merge(props, jwk, {
          kty: kty
        });
        return self.add(jwk);
      });
    }
  });
  /**
   * @method JWK.KeyStore#add
   * @description
   * Adds a Key to this KeyStore. If {jwk} is a string, it is first
   * parsed into a plain JSON object. If {jwk} is already an instance
   * of JWK.Key, its (public) JSON representation is first obtained
   * then applied to a new JWK.Key object within this KeyStore.
   *
   * @param {String|Object} jwk The JSON Web Key (JWK)
   * @returns {Promise} The promise for the added key
   * @throws {Error} If the key type is not supported
   */
  Object.defineProperty(this, "add", {
    value: function(jwk) {
      if (typeof jwk === "string") {
        jwk = JSON.parse(jwk);
      } else if (JWKStore.isKey(jwk)) {
        // assume a complete duplicate is desired
        jwk = jwk.toJSON(true);
      }

      var keytype = registry.get(jwk.kty);
      if (!keytype) {
        return Promise.reject(new Error("unsupported key type"));
      }

      var self = this,
          promise = keytype.prepare(jwk);
      return promise.then(function(cfg) {
        return new JWK.BaseKey(jwk.kty, self, jwk, cfg);
      }).then(function(jwk) {
        var kid = jwk.kid || "";
        var keys = keysets[kid] = keysets[kid] || [];
        keys.push(jwk);

        return jwk;
      });
    }
  });
  /**
   * @method JWK.KeyStore#remove
   * @description
   * Removes a Key from this KeyStore.
   *
   * **NOTE:** The removed Key's {keystore} property is not changed.
   *
   * @param {JWK.Key} jwk The key to remove.
   */
  Object.defineProperty(this, "remove", {
    value: function(jwk) {
      if (!jwk) {
        return;
      }

      var keys = keysets[jwk.kid];
      if (!keys) {
        return;
      }

      var pos = keys.indexOf(jwk);
      if (pos === -1) {
        return;
      }

      keys.splice(pos, 1);
      if (!keys.length) {
        delete keysets[jwk.kid];
      }
    }
  });

  /**
   * @method JWK.KeyStore#all
   * @description
   * Retrieves all of the contained Keys that optinally match all of the
   * given properties.
   *
   * If {props} are specified, this method only returns Keys which exactly
   * match the given properties. The properties can be any of the
   * following:
   *
   * + **alg**: The algorithm for the Key.
   * + **use**: The usage for the Key.
   * + **kid**: The identifier for the Key.
   *
   * If no properties are given, this method returns all of the Keys for this
   * KeyStore.
   *
   * @param {Object} [props] The properties to match against
   * @param {Boolean} [local = false] `true` if only the Keys
   *        directly contained by this KeyStore should be returned, or
   *        `false` if it should return all Keys of this KeyStore and
   *        its ancestors.
   * @returns {JWK.Key[]} The list of matching Keys, or an empty array if no
   *          matches are found.
   */
  Object.defineProperty(this, "all", {
    value: function(props, local) {
      props = props || {};

      var candidates = [];
      var matches = function(key) {
        // match on 'kty'
        if (props.kty &&
            key.kty &&
            props.kty !== key.kty) {
          return false;
        }
        // match on 'use'
        if (props.use &&
            key.use &&
            props.use !== key.use) {
          return false;
        }
        // match on 'alg'
        if (props.alg) {
          if (props.alg !== "dir" &&
              key.alg &&
              props.alg !== key.alg) {
            return false;
          }
          return key.supports(props.alg);
        }
        //TODO: match on 'key_ops'

        return true;
      };
      Object.keys(keysets).forEach(function(id) {
        if (props.kid && props.kid !== id) {
          return;
        }

        var keys = keysets[id].filter(matches);
        if (keys.length) {
          candidates = candidates.concat(keys);
        }
      });

      if (!local && parent) {
        candidates = candidates.concat(parent.all(props));
      }

      return candidates;
    }
  });
  /**
   * @method JWK.KeyStore#get
   * @description
   * Retrieves the contained Key matching the given {kid}, and optionally
   * all of the given properties.  This method equivalent to calling
   * {@link JWK.Store#all}, then returning the first Key whose
   * "kid" is {kid}. If {kid} is undefined, then the first Key that
   * is returned from `all()` is returned.
   *
   * @param {String} [kid] The key identifier to match against.
   * @param {Object} [props] The properties to match against.
   * @param {Boolean} [local = false] `true` if only the Keys
   *        directly contained by this KeyStore should be returned, or
   *        `false` if it should return all Keys of this KeyStore and
   *        its ancestors.
   * @returns {JWK.Key} The Key matching {kid} and {props}, or `null`
   *          if no match is found.
   */
  Object.defineProperty(this, "get", {
    value: function(kid, props, local) {
      // reconcile arguments
      if (typeof kid === "boolean") {
        local = kid;
        props = kid = null;
      } else if (typeof kid === "object") {
        local = props;
        props = kid;
        kid = null;
      }

      // fixup props
      props = props || {};
      if (kid) {
        props.kid = kid;
      }

      var candidates = this.all(props, true);
      if (!candidates.length && parent && !local) {
        candidates = parent.get(props, local);
      }
      return candidates[0] || null;
    }
  });

  /**
   * @method JWK.KeyStore#toJSON
   * @description
   * Generates a JSON representation of this KeyStore, which conforms
   * to a JWK Set from {I-D.ietf-jose-json-web-key}.
   *
   * @param {Boolean} [isPrivate = false] `true` if the private fields
   *        of stored keys are to be included.
   * @returns {Object} The JSON representation of this KeyStore.
   */
  Object.defineProperty(this, "toJSON", {
    value: function(isPrivate) {
      var keys = [];

      Object.keys(keysets).forEach(function(kid) {
        var items = keysets[kid].map(function(k) {
          return k.toJSON(isPrivate);
        });
        keys = keys.concat(items);
      });

      return {
        keys: keys
      };
    }
  });
};

/**
 * Determines if the given object is an instance of JWK.KeyStore.
 *
 * @param {Object} obj The object to test
 * @returns {Boolean} `true` if {obj} is an instance of JWK.KeyStore,
 *          and `false` otherwise.
 */
JWKStore.isKeyStore = function(obj) {
  if (!obj) {
    return false;
  }

  if ("object" !== typeof obj) {
    return false;
  }

  if ("function" !== typeof obj.get ||
      "function" !== typeof obj.all ||
      "function" !== typeof obj.generate ||
      "function" !== typeof obj.add ||
      "function" !== typeof obj.remove) {
    return false;
  }

  return true;
};

/**
 * Creates a new empty KeyStore.
 *
 * @returns {JWK.KeyStore} The empty KeyStore.
 */
JWKStore.createKeyStore = function() {
  return new JWKStore(GLOBAL_REGISTRY);
};

/**
 * Coerces the given object into a KeyStore. This method uses the following
 * algorithm to coerce {ks}:
 *
 * 1. if {ks} is an instance of JWK.KeyStore, it is returned directly
 * 2. if {ks} is a string, it is parsed into a JSON value
 * 3. if {ks} is an array, it creates a new JWK.KeyStore and calls {@link
 *    JWK.KeyStore#add} for each element in the {ks} array.
 * 4. if {ks} is a JSON object, it creates a new JWK.KeyStore and calls {@link
 *    JWK.KeyStore#add} for each element in the "keys" property.
 *
 * @param {Object|String} ks The value to coerce into a
 *        KeyStore
 * @returns {Promise(JWK.KeyStore)} A promise for the coerced KeyStore.
 */
JWKStore.asKeyStore = function(ks) {
  if (JWKStore.isKeyStore(ks)) {
    return Promise.resolve(ks);
  }

  var store = JWKStore.createKeyStore(),
      keys;

  if (typeof ks === "string") {
    ks = JSON.parse(ks);
  }

  if (Array.isArray(ks)) {
    keys = ks;
  } else if ("keys" in ks) {
    keys = ks.keys;
  } else {
    return Promise.reject("invalid keystore");
  }

  keys = keys.map(function(k) {
    return store.add(k);
  });

  var promise = Promise.all(keys);
  promise = promise.then(function() {
    return store;
  });

  return promise;
};


/**
 * Determines if the given object is a JWK.Key instance.
 *
 * @param {Object} obj The object to test
 * @returns `true` if {obj} is a JWK.Key
 */
JWKStore.isKey = function(obj) {
  if (!obj) {
    return false;
  }

  if ("object" !== typeof obj) {
    return false;
  }

  if (!JWKStore.isKeyStore(obj.keystore)) {
    return false;
  }

  if ("string" !== typeof obj.kty ||
      "number" !== typeof obj.length ||
      "function" !== typeof obj.algorithms ||
      "function" !== typeof obj.supports ||
      "function" !== typeof obj.encrypt ||
      "function" !== typeof obj.decrypt ||
      "function" !== typeof obj.wrap ||
      "function" !== typeof obj.unwrap ||
      "function" !== typeof obj.sign ||
      "function" !== typeof obj.verify) {
    return false;
  }

  return true;
};

/**
 * Coerces the given object into a Key. If {key} is an instance of JWK.Key,
 * it is returned directly. Otherwise, this method first creates a new
 * JWK.KeyStore and calls {@link JWK.KeyStore#add} on this new KeyStore.
 *
 * @param {Object|String} key The value to coerce into a Key
 * @returns {Promise(JWK.Key)} A promise for the coerced Key.
 */
JWKStore.asKey = function(key) {
  if (JWKStore.isKey(key)) {
    return Promise.resolve(key);
  }

  var ks = JWKStore.createKeyStore();
  key = ks.add(key);

  return key;
};

module.exports = {
  KeyRegistry: JWKRegistry,
  KeyStore: JWKStore,
  registry: GLOBAL_REGISTRY
};