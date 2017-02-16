require( 'promise/polyfill' );

define(['vue'], function( Vue ) {
	const request = require( './request' );
	const Compiler = require( './Compiler' );

	const parser = new DOMParser;
	
	function parse( fragment ) {
		const doc = parser.parseFromString( `<!doctype html><html><head></head><body>${fragment}</body></html>`, 'text/html' );
		return doc.body;
	}
	
	return {
		load( name, req, onload, config ) {
			request( name+'.vue', function( err, res ) {
				if ( err )
					return onload.error( err );
				try {
					const vueComponentElement = parse( res );
					const compiler = new Compiler( vueComponentElement );
					compiler.compile({ name, require: req, config })
						.then(function( component ) {
							Vue.component( name, component );
							onload( component );
						}, function( err ) {
							onload.error( err );
						})
					;
				} catch( err ) {
					onload.error( err );
				}
			});
		}
	}
});
