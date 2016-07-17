function parse_xml(str) {
    return (new window.DOMParser()).parseFromString(str, "text/xml");
}

function load_materialx(path, cb) {
    var mtls = {};
    fetch(path).then(
        function(res) {
            if(res.ok) {
                res.text().then(function(data) {
                    var xml = parse_xml(data);
                    var mtlX = parse_materialx(xml, mtls);
                    if(typeof cb !== 'undefined')
                        cb(mtlX);
                });
            }
        });
}

function parse_materialx(mtlx, mtls) {
    var materials = mtlx.getElementsByTagName('material');
    var shaders = mtlx.getElementsByTagName('shader');
    var opgraphs = mtlx.getElementsByTagName('opgraph');
    var geominfos = mtlx.getElementsByTagName('geominfo')

    var udims = [];

    for(var i = 0; i < geominfos.length; i++) {
        var geominfo = geominfos[i];
        var udim = geominfo.getAttribute('udim');
        if(!!udim) {
            udims.push(udim);
        }
    }

    function get_named(array, name) {
        for(var i = 0; i < array.length; i++) {
            if(array[i].getAttribute('name') === name) {
                return array[i];
            }
        }
    }

    function get_file_prefix(node) {
        var prefix = node.getAttribute('fileprefix');
        if(prefix === null || prefix.length === 0) {
            prefix = "";
        }
        else {
            if(prefix[prefix.length-1] !== '/') {
                prefix += '/';
            }
        }
        if(node.parentElement !== null)
            prefix = get_file_prefix(node.parentElement) + prefix;
        return prefix;
    }

    function parse_mtlx_value(value, type) {
        switch(type) {
        case 'float':
            return parseFloat(value);
        case 'color3':
            return value.split(',').map(function(v) { return parseFloat(v); });
        default:
            return value;
        }
    }

    var materialList = {};
    if(typeof mtls !== 'undefined')
        materialList = mtls;

    var out = {materials: materialList, udims: udims};

    for(var i = 0; i < materials.length; i++) {
        var m = materials[i];
        var outMat = {};
        materialList[m.getAttribute('name')] = outMat;
        var refs = m.getElementsByTagName('shaderref');
        var shaderRef = refs[0]; //XXX
        {
            var shaderName = shaderRef.getAttribute('name');
            var shader = get_named(shaders, shaderName);
            var inputs = shader.getElementsByTagName('input');
            var shaderInputs = {};
            outMat.shaderInputs = shaderInputs;
            outMat.shader = shaderName;
            for(var j = 0; j < inputs.length; j++) {
                var shaderInput = {};
                shaderInputs[inputs[j].getAttribute('name')] = shaderInput;
                shaderInput.type = inputs[j].getAttribute('type');
                var value = inputs[j].getAttribute('value');
                if(value !== null) {
                    shaderInput.input = {type: 'value', valueType: shaderInput.type, value: parse_mtlx_value(value, shaderInput.type)};
                    shaderInput.value = value;
                    shaderInput.value = parse_mtlx_value(shaderInput.value, shaderInput.type);
                }
                var opgraphName = inputs[j].getAttribute('opgraph');
                var graphOutputName = inputs[j].getAttribute('graphoutput');
                if(opgraphName !== null && graphOutputName !== null) {
                    var opgraph = get_named(opgraphs, opgraphName);
                    var graphOutput = get_named(opgraph.getElementsByTagName('output'), graphOutputName);
                    var inParam = get_named(graphOutput.getElementsByTagName('parameter'), 'in');
                    if(typeof inParam !== 'undefined') {
                        var inNode = get_named(opgraph.children, inParam.getAttribute('value'));
                        if(typeof inNode !== 'undefined') {
                            //XXX: Handling file only here.
                            var file = get_named(inNode.getElementsByTagName('parameter'), 'file').getAttribute('value');
                            var file_prefix = get_file_prefix(inNode);
                            file = file_prefix + file;
                            shaderInput.file = file;
                            shaderInput.input = {type: 'file', value: file};
                        }
                    }
                }
            }
        }
        //'override'
    }
    return out;
}

function load_materialx_shaders(path, cb) {

    var uniPrefix = "u_";
    var accPrefix = "mat_";

    var mtlxTypes = {
        'float': {
            'glslType': 'float',
            'uniformType': '1f',
            'defaultGLSL': '0.0',
            'downcast': '.r',
        },
        'color3': {
            'glslType': 'vec3',
            'uniformType': '3f',
            'defaultGLSL': 'vec3(0.0, 0.0, 0.0)',
            'downcast': '.rgb',
        },
        'color4': {
            'glslType': 'vec4',
            'uniformType': '4f',
            'defaultGLSL': 'vec4(0.0, 0.0, 0.0, 0.0)',
            'downcast': '.rgba',
        },
    };

    var nameCounter = 0;

    function gen_name() {
        return "lvar" + nameCounter++;
    }

    function add_opgraph_node(node, uNamer, uniforms, decls) {
        var accessors = [];
        var ret = '';
        var retType = 'none';
        switch(node.type) {
        case 'file':
            var texCoord = "vUv";
            //XXX: This needs to get loaded.
            var channelName = uNamer();
            uniforms[uniPrefix + channelName] = {type: 't', file: node.value};
            decls.push("uniform sampler2D " + uniPrefix + channelName + ";");
            ret = gen_name();
            retType = 'color4';
            accessors.push("vec4 " + ret + " = texture2D(" + uniPrefix + channelName + ", " + texCoord + ");");
            break;
        case 'value':
            var channelName = uNamer();
            var uniformType = mtlxTypes[node.valueType].uniformType;
            var glsltype = mtlxTypes[node.valueType].glslType;
            uniforms[uniPrefix + channelName] = {type: uniformType, value: node.value};
            decls.push("uniform " + glsltype + " " + uniPrefix + channelName + ";");
            ret = gen_name();
            retType = node.valueType;
            accessors.push(glsltype + " " + ret + " = " + uniPrefix + channelName + ";");
            break;
        }
        return {accessors: accessors, ret: ret, retType: retType};
    }

    function glslconvert(frag, fromType, toType) {
        //XXX
        if(fromType === 'float')
            return frag;
        else
            return frag + mtlxTypes[toType].downcast;
    }

    var materials = {};

    load_materialx(path, function(mtlX) {
        var mtl = mtlX.materials;
        for(var s in mtl) {
            var uniforms = {};
            var decls = [];
            var accessors = [];

            var material = {
                uniforms: uniforms,
                decls: decls,
                accessors: accessors,
            };

            materials[s] = material;

            for(var i in mtl[s].shaderInputs) {
                //XXX: If the mtlx is from a malicious source, we could create harmful shaders.
                var input = mtl[s].shaderInputs[i];
                var glsltype = mtlxTypes[input.type].glslType;
                var downcast = mtlxTypes[input.type].downcast;

                var nameCounter = 0;
                function uNamer() {
                    var name = i;
                    if(nameCounter > 0)
                        name += nameCounter;
                    nameCounter++;
                    return name;
                }

                decls.push(glsltype + " " + accPrefix + i + "();");

                accessors.push(glsltype + " " + accPrefix + i + "() {");
                var ret = add_opgraph_node(input.input, uNamer, uniforms, decls);
                if(ret.ret.length === 0)
                    ret.ret = mtlxTypes[input.type].defaultGLSL;
                for(var a in ret.accessors) { accessors.push(ret.accessors[a])  }
                //XXX: Type conversion based on ret.retType;
                accessors.push("return " + glslconvert(ret.ret, ret.retType, input.type) + ";");
                accessors.push("}");
            }
            if(mtlX.udims.length > 0) {
                material.udims = mtlX.udims;
            }
        }
        if(typeof cb !== 'undefined')
            cb(materials);
    });
    return materials;
}

if(typeof THREE !== 'undefined') {
    var manager = new THREE.LoadingManager();
    manager.onProgress = function(item, loaded, total) {
        console.log(item, loaded, total);
    }
    var loader = new THREE.ImageLoader(manager);

    function load_shadermaterial_uniforms(shaderMat, mtl, udim, cb) {

        if(!!udim) {
            shaderMat = shaderMat.clone();
        }

        var uniforms = mtl.uniforms;

        var nret = 0;
        var needed = 0;

        function maybeCB() {
            nret++;
            if(nret === needed)
                cb(shaderMat);
        }

        for(var u in uniforms) {
            if(typeof uniforms[u].file !== 'undefined') {
                var texture = new THREE.Texture();
                needed++;
                var file = uniforms[u].file;
                if(!!udim) {
                    file = file.replace("%UDIM", udim);
                }
                loader.load(file, function(u){
                    return function(image) {
                        texture.image = image;
                        texture.magFilter = THREE.NearestFilter;
                        uniforms[u].value = texture;
                        texture.needsUpdate = true;
                        maybeCB();
                    }
                }(u));
            }
        }
        uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib["lights"], THREE.UniformsLib["shadowmap"], uniforms]);
        shaderMat.uniforms = uniforms;
    }

    function create_shadermaterial(mtl, cb) {
        var material = new THREE.ShaderMaterial({});

        var nret = 0;
        var needed = 2;

        function maybeCB() {
            nret++;
            if(nret === needed)
                cb(material);
        }

        material.lights = true;

        fetch('/shaders/surface_vert.glsl').then(
            function(res) {
                if(res.ok) {
                    res.text().then(function(text) {
                        material.vertexShader = text;
                        material.needsUpdate = true;
                        maybeCB();
                    });
                }
                else {
                    maybeCB();
                }
            }
        );

        fetch('/shaders/surface_frag.glsl').then(
            function(res) {
                if(res.ok) {
                    res.text().then(function(text) {
                        var fragSrc =
                            mtl.decls.join('\n') + "\n\n" +
                            text + "\n\n" +
                            mtl.accessors.join('\n') + "\n\n";
                        material.fragmentShader = fragSrc;
                        material.needsUpdate = true;
                        maybeCB();
                    });
                }
                else {
                    maybeCB();
                }
            }
        );
    }

    function create_materialx_shadermaterials(path, cb) {
        load_materialx_shaders(path, function(mtls) {
            var materials = {};
            var retCnt = 0;
            var nret = 0;
            for(var mat in mtls) {
                retCnt++;
                if(!!mtls[mat].udims && mtls[mat].udims.length) {
                    for(var u = 0; u < mtls[mat].udims.length; u++) {
                        retCnt++;
                    }
                }
            }
            function trycb() {
                nret++;
                if(nret == retCnt) {
                    cb(materials);
                }
            }
            for(var mat in mtls)
            {
                (function(mat) {
                    create_shadermaterial(mtls[mat], function(material) {
                        var udim0 = null;
                        if(!!mtls[mat].udims && mtls[mat].udims.length) {
                            udim0 = mtls[mat].udims[0];
                            for(var u = 0; u < mtls[mat].udims.length; u++) {
                                var udim = mtls[mat].udims[u];
                                (function(udim) {
                                    load_shadermaterial_uniforms(material, mtls[mat], udim, function(material) {
                                        materials[mat + "." + udim] = material;
                                        trycb()
                                    });
                                })(udim);
                            }
                        }
                        load_shadermaterial_uniforms(material, mtls[mat], udim0, function(material) {
                            materials[mat] = material;
                            trycb()
                        });
                    });
                })(mat);
            }
        });
    }

    function create_materialx_shadermaterial(path, matName, udim, cb) {
        load_materialx_shaders(path, function(mtls) {
            create_shadermaterial(mtls[matName], function(material) {
                load_shadermaterial_uniforms(material, mtls[matName], udim, function(material) {
                    cb(material);
                });
            });
        });
    }
}
