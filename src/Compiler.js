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

	transpileScript( compilation ) {
		const requires          = [];
		const globalIdentifiers = {};
		compilation.ast.body.forEach((node) => {
			if ( node.type === 'ExportDefaultDeclaration' ) {
				compilation.magicString.overwrite( node.start, node.declaration.start, "module.exports = " );
				return;
			}
			if ( node.type === 'ExportNamedDeclaration' )
				throw new Error( "Only export default is supported" );
			if ( node.type === 'ImportDeclaration' ) {
				const file = node.source.value;
				const imports = [];
				if ( requires.indexOf( file ) < 0 ) {
					globalIdentifiers[ file ] = `v__guid__helper__${GUID_HELPER++}`;
					requires.push( file );
					imports.push( `var ${globalIdentifiers[ file ]} = require(${JSON.stringify(file)});` );
				}

				const identifier = globalIdentifiers[ file ];
				if ( node.specifiers && node.specifiers.length > 0 ) {
					for ( let i = 0, len = node.specifiers.length; i<len; ++i ) {
						const specifier = node.specifiers[ i ];
						if ( !specifier.imported ) {
							imports.push( `var ${specifier.local.name} = ((${identifier} && ${identifier}.__esModule) ? ${identifier}['default'] : ${identifier})` );
						} else {
							imports.push( `var ${specifier.local.name} = ${identifier}[${JSON.stringify(specifier.imported.name)}]` );
						}
					}
				}
				

				compilation.magicString.overwrite( node.start, node.end, imports.join("\n") );
			}
		});
		return {
			requires: requires,
			code:     compilation.magicString.toString()
		}
	}

	compileScript( output, options ) {
		const script = this._componentElement.querySelector( 'script' );
		if ( !script )
			return;
		
		const compilation      = buble.compile( script.innerHTML, { transforms: { modules: false } } );
		const transpiledScript = this.transpileScript( compilation );
		const requires = transpiledScript.requires;
		return options.require( requires )
			.then( function( require ) {
				const isolatedVm       = new Function( 'global', 'require', VM_HEADER+transpiledScript.code+VM_FOOTER );
				const vmComponent      = isolatedVm( options.global || window, require );
				for ( let key in vmComponent )
					output.component[ key ] = vmComponent[ key ];
			})
		;
	}

	compileTemplate( output ) {
		const template = this._componentElement.querySelector( 'template' );
		output.component.template = template.innerHTML;
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
		return Promise.resolve()
			.then(() => {
				return Promise.all([
					this.compileScript( output, options ),
					this.compileTemplate( output, options ),
					this.compileStyle( output, options )
				]);
			})
			.then(() => { return output.component; })
		;
	}
	
};
