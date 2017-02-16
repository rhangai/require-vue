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

	compileScript( component ) {
		const script = this._componentElement.querySelector( 'script' );
		if ( !script )
			return Promise.reject();

		const transpiledScript = buble.transform( script.innerHTML );
		console.log( transpiledScript );
		const isolatedVm       = new Function( VM_HEADER+transpiledScript.code+VM_FOOTER );
		const vmComponent      = isolatedVm();
		for ( let key in vmComponent )
			component[ key ] = vmComponent[ key ];
	}

	compileTemplate( component ) {
		const template = this._componentElement.querySelector( 'template' );
		const tag      = template.getAttribute( 'tag' ) || 'div';
		const classes  = template.getAttribute( 'class' )||'';
		component.template = `<${tag} class=${JSON.stringify(classes+" "+this._guid)}>${template.innerHTML}</${tag}>`;
	}

	compileStyle( component ) {
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

	compile() {
		const component = {};
		return Promise.resolve()
			.then(() => this.compileScript( component ))
			.then(() => this.compileTemplate( component ))
			.then(() => this.compileStyle( component ))
			.then(() => { return component; })
		;
	}
	
};
