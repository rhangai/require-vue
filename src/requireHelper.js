function buildDependencyRequire( options ) {
	options = options || {};
	const req = options.require;
	return function( deps ) {
		deps = deps || [];

		const resolvedMap = {};
		const module      = deps.map(function( dep, i ) {
			return new Promise(function( resolve, reject ) {
				req( [dep], function( v ) {
					resolvedMap[ dep ] = v;
					resolve();
				}, reject );
			});
		});
		return Promise.all( module )
			.then(function( d ) {
				return function( name ) {
					return resolvedMap[ name ];
				};
			});
		;
	};
}

module.exports = {
	buildDependencyRequire: buildDependencyRequire
};
