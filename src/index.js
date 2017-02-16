require( 'promise/polyfill' );
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(['vue'], factory);
    } else {
        root.VueRequire = factory(root.Vue);
    }
}(this || window, function( Vue ) {
	const request = require( './request' );
	const requireHelper = require( './requireHelper' );
	const Compiler = require( './Compiler' );
	
	const parser = new DOMParser;
	
	function parse( fragment ) {
		const doc = parser.parseFromString( `<!doctype html><html><head></head><body>${fragment}</body></html>`, 'text/html' );
		return doc.body;
	}
	
	const VueRequire = {
		registerAllComponentsTags( options ) {
			options = options || {};
			const links = document.getElementsByTagName( 'link' );
			const tags  = [];
			const g     = options.global || window;
			
			const require = options.require || requireHelper.buildDependencyRequire({
				require( deps, cb, errCb ) {
					const dep = deps[0];
					if ( dep.substr(0, 2) === 'v!' ) {
						const path = dep.substr(2);
						const name = VueRequire.pathToName( path );

						cb( function( resolve, reject ) {
							return VueRequire.loadComponent( path+'.vue', { name, require });
						});
						return;
					}
					if ( options.map && options.map[ dep ] )
						cb( g[ options.map[ dep ] ] );
					else
						cb( g[ dep ] );
				}
			});
			for( let i = 0, len = links.length; i<len; ++i ) {
				const link = links[ i ];
				if ( ( link.rel === 'template/vue' ) || ( link.type === 'text/vue' ) ) {
					const name = link.getAttribute( 'name' ) || this.pathToName( link.href );
					Vue.component( name, function( resolve, reject ) {
						VueRequire.loadComponent( link.href, { name, require })
							.then( resolve, reject );
					});
				}
			}
			return Promise.resolve();
		},
		loadComponent( path, options ) {
			return request( path )
				.then(function( res ) {
					const vueComponentElement = parse( res );
					const compiler = new Compiler( vueComponentElement );
					return compiler.compile( options )
						.then(function( component ) {
							return component;
						})
					;
				})
			;
		},
		pathToName( path ) {
			return path;
		},
		load( name, req, onload, config ) {
			const require = requireHelper.buildDependencyRequire({ require: req });
			onload(function() {
				return VueRequire.loadComponent( name+'.vue', { name, config, require } );
			});
		}
	}
	return VueRequire;
}));
