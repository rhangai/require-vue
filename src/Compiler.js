require( "promise/polyfill" );
const buble = require( './buble' );
const less  = require( 'less/lib/less-browser/bootstrap' );

let GUID_HELPER = 0;

const VM_HEADER = `
var exports = {};
var module  = {};
Object.defineProperty( module, 'exports', {
	get: function()  { return exports; },
	set: function(v) { exports = v; return exports; },
});
(function() {
`;
const VM_FOOTER = `
}());
return exports;
`;

module.exports = class {
	
	constructor( componentElement ) {
		this._guid = `v__guid__helper--${GUID_HELPER++}`;
		this._componentElement = componentElement;
	}

	compileScript( output, options ) {
		const script = this._componentElement.querySelector( 'script' );
		if ( !script )
			return Promise.reject();
		
		const transpiledScript = buble.transform( script.innerHTML );

		const requires = [];
		const code = transpiledScript.code.replace( /require\(\s*([\"'])((?:\\\1|.)*?)\1\s*\)/g, function( match, quote, moduleName ) {
			requires.push( moduleName );
		});
		return new Promise(function( resolve, reject ) {
			options.require( ['require'].concat(requires), function( require ) {
				resolve( require );
			}, reject );
		}).then( function( require ) {
			const isolatedVm       = new Function( 'require', VM_HEADER+transpiledScript.code+VM_FOOTER );
			const vmComponent      = isolatedVm( require );
			for ( let key in vmComponent )
				output.component[ key ] = vmComponent[ key ];
		});
	}

	compileTemplate( output ) {
		const template = this._componentElement.querySelector( 'template' );
		const tag      = template.getAttribute( 'tag' ) || 'div';
		const classes  = template.getAttribute( 'class' )||'';
		output.component.template = `<${tag} class=${JSON.stringify(classes+" "+this._guid)}>${template.innerHTML}</${tag}>`;
	}

	compileStyle( output ) {
		const style = this._componentElement.querySelector( 'style' );
		if ( !style )
			return;
		
		const styleString = `.${this._guid} { ${style.textContent} }`;
		return new Promise(function( resolve, reject ) {
			less.render( styleString, function( err, output ) {
				if ( err ) {
					reject( err );
					return;
				}
				resolve( output );
			});
		}).then(function( { css } ) {
			if ( !css )
				return;
			const head          = document.head || document.body;
			const compiledStyle = document.createElement( 'style' );
			const styleContent  = document.createTextNode( css );
			compiledStyle.appendChild( styleContent );
			head.appendChild( compiledStyle );
		});
	}

	compile( options ) {
		const output = {
			component: {}
		};
		return Promise.all([
			this.compileScript( output, options ),
			this.compileTemplate( output, options ),
			this.compileStyle( output, options )
		]).then(() => { return output.component; });
	}
	
};
